import {
  ActionMessageSchema,
  AgentToRendererMessageSchema,
  basicCatalog,
  CreateSurfaceMessageSchema,
  MessageProcessor,
  STRICT_VALIDATION,
  type AgentToRendererMessage,
  type CreateSurfaceMessage,
  type SurfaceModel,
} from "@a2ui/web_core/v1_0";
import { z } from "zod";

const CATALOG_ID = basicCatalog.id;
export const promptSchema = z.string().trim().min(1).max(2000);
export const conversationSchema = z.array(
  z
    .object({
      generationId: z.uuid(),
      prompt: promptSchema,
      ui: z.unknown().transform(parseSavedUi).optional(),
    })
    .refine(
      (turn) => !turn.ui || turn.ui.generationId === turn.generationId,
      "Saved response has an invalid generation identity",
    ),
);
export type Conversation = z.infer<typeof conversationSchema>;
export const decisionSchema = z.object({ generationId: z.uuid(), approved: z.boolean() }).strict();

const rendererMetadataSchema = z
  .object({
    a2uiRendererCapabilities: z
      .object({
        "1.0": z
          .object({ supportedCatalogIds: z.array(z.literal(CATALOG_ID)).min(1).max(1) })
          .strict(),
      })
      .strict(),
    a2uiRendererDataModel: z
      .object({
        version: z.literal("1.0"),
        surfaces: z.record(z.string(), z.object({ feedback: z.string().max(2000) }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const requestSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("generate"), prompt: promptSchema, metadata: rendererMetadataSchema })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      generationId: z.uuid(),
      message: z.unknown().transform((value) => ActionMessageSchema.parse(value)),
      metadata: rendererMetadataSchema,
    })
    .strict(),
]);
export type UiRequest = z.infer<typeof requestSchema>;
export type RendererMetadata = z.infer<typeof rendererMetadataSchema>;
export type UiMessage = Exclude<
  AgentToRendererMessage,
  { callRendererFunction: unknown } | { agentFunctionResponse: unknown }
>;

const allowedComponents = new Set([
  "Text",
  "Column",
  "Row",
  "Card",
  "Button",
  "TextField",
  "Divider",
]);

const feedbackBindingSchema = z.object({ "@path": z.literal("/feedback") }).strict();

const generatedActionSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("reviseUi"),
      context: z
        .object({
          prompt: z.union([promptSchema, feedbackBindingSchema]),
        })
        .strict(),
    })
    .strict(),
  z.object({ name: z.literal("dismissNotes"), context: z.object({}).strict() }).strict(),
]);

// These are example policy restrictions. Upstream owns protocol/catalog validation and bindings.
function checkUiPolicy(value: unknown): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const child of value) checkUiPolicy(child);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      ["@call", "call", "functionCall", "@macro", "@catalogId", "@metadata", "metadata"].includes(
        key,
      )
    )
      throw new Error("This example accepts Basic Catalog components and local event actions only");
    if (key === "component" && (typeof child !== "string" || !allowedComponents.has(child)))
      throw new Error("Generated component is outside the UI catalog subset");

    if (key === "event") {
      generatedActionSchema.parse(child);
    }

    checkUiPolicy(child);
  }
}

export function parseUiMessage(value: unknown): UiMessage {
  const message = AgentToRendererMessageSchema.parse(value);
  if ("callRendererFunction" in message || "agentFunctionResponse" in message)
    throw new Error("Remote function calls are outside this example's supported subset");
  if ("createSurface" in message && message.createSurface.catalogId !== CATALOG_ID)
    throw new Error("Only the registered Basic Catalog is supported");
  checkUiPolicy(message);
  return message;
}

export function uiSurfaceIds(generationId: string) {
  return {
    canvas: generationId + ":canvas",
    controls: generationId + ":controls",
    notes: generationId + ":notes",
  };
}

export function messageSurfaceId(message: UiMessage): string {
  if ("createSurface" in message) return message.createSurface.surfaceId;
  if ("updateComponents" in message) return message.updateComponents.surfaceId;
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId;
  return message.deleteSurface.surfaceId;
}

const savedUiShape = z
  .object({
    schemaVersion: z.literal(2),
    generationId: z.uuid(),
    bootstrapMessages: z.array(z.unknown()).min(1).max(3),
  })
  .strict();
export interface SavedUi {
  schemaVersion: 2;
  generationId: string;
  bootstrapMessages: CreateSurfaceMessage[];
}

export function parseSavedUi(value: unknown): SavedUi {
  const shape = savedUiShape.safeParse(value);
  if (!shape.success) throw new Error("This saved UI is incompatible. Start a New chat.");
  const allowedIds = Object.values(uiSurfaceIds(shape.data.generationId));

  const bootstrapMessages = shape.data.bootstrapMessages.map((candidate) => {
    const message = CreateSurfaceMessageSchema.parse(parseUiMessage(candidate));
    if (!allowedIds.includes(message.createSurface.surfaceId))
      throw new Error("Invalid saved surface identity");
    return message;
  });
  if (
    new Set(bootstrapMessages.map((message) => message.createSurface.surfaceId)).size !==
    bootstrapMessages.length
  )
    throw new Error("Saved UI contains duplicate surfaces");
  const processor = new MessageProcessor([basicCatalog], undefined, {
    validationConfig: STRICT_VALIDATION,
  });

  try {
    processor.processMessages(bootstrapMessages);
  } finally {
    processor.dispose();
  }

  return { ...shape.data, bootstrapMessages };
}

/** Materialize current upstream state, never its processors, signals, Maps or event history. */
export function snapshotSurfaces(generationId: string, surfaces: Iterable<SurfaceModel>): SavedUi {
  const bootstrapMessages = [...surfaces].map((surface) =>
    CreateSurfaceMessageSchema.parse({
      version: "1.0",
      createSurface: {
        surfaceId: surface.id,
        catalogId: CATALOG_ID,
        sendDataModel: surface.sendDataModel,
        components: [...surface.componentsModel.values].map((component) =>
          structuredClone(component.componentTree),
        ),
        dataModel: structuredClone(surface.dataModel.get("/")),
      },
    }),
  );
  return parseSavedUi({ schemaVersion: 2, generationId, bootstrapMessages });
}

/** Check the revision and dismissal controls after upstream protocol and topology validation. */
export function validateGeneratedUi(saved: SavedUi): SavedUi {
  const ids = uiSurfaceIds(saved.generationId);

  for (const { createSurface: surface } of saved.bootstrapMessages) {
    const controls = surface.surfaceId === ids.controls;
    if (Boolean(surface.sendDataModel) !== controls)
      throw new Error("Only the controls surface must send its data model");
    if (controls)
      z.object({ feedback: z.string().max(2000) })
        .strict()
        .parse(surface.dataModel);
    const components = surface.components ?? [];

    const actions = components
      .filter((component) => component.component === "Button")
      .map((component) => {
        const action = z
          .object({ event: generatedActionSchema })
          .strict()
          .parse(component["action"]).event;
        if (controls && action.name === "reviseUi")
          feedbackBindingSchema.parse(action.context.prompt);
        else if (surface.surfaceId === ids.canvas && action.name === "reviseUi")
          promptSchema.parse(action.context.prompt);
        else if (surface.surfaceId !== ids.notes || action.name !== "dismissNotes")
          throw new Error("Action is on an unexpected surface");
        return action.name;
      });

    const fields = components.filter((component) => component.component === "TextField");

    for (const field of fields) {
      if (!controls) throw new Error("Only controls may contain editable fields");
      feedbackBindingSchema.parse(field["value"]);
    }

    if (controls && !fields.length)
      throw new Error("The controls surface must contain a feedback field");
    const requiredAction = surface.surfaceId === ids.notes ? "dismissNotes" : "reviseUi";
    if (!actions.includes(requiredAction))
      throw new Error("Generated UI is missing a required action");
  }

  return saved;
}

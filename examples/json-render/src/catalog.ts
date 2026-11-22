import {
  ActionBindingSchema,
  defineCatalog,
  resolveElementProps,
  validateSpec,
  type Spec,
} from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const promptSchema = z.string().trim().min(1).max(2000);
export const promptRequestSchema = z.object({ prompt: promptSchema }).strict();
export const revisionSchema = promptRequestSchema.extend({ generationId: z.uuid() });
export const requestSchema = z.union([
  promptRequestSchema,
  revisionSchema.extend({ action: z.literal("reviseUi") }),
]);
export const decisionSchema = z
  .object({ generationId: z.string().uuid(), approved: z.boolean() })
  .strict();

export const catalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({ title: z.string() }),
      slots: ["default"],
      description: "A titled container for dashboards, forms, product cards or other UI.",
    },
    Text: { props: z.object({ text: z.string() }), description: "Plain text, never HTML." },
    TaskList: {
      props: z.object({ tasks: z.array(z.string()) }),
      description: "A short checklist or list of facts.",
    },
    Grid: {
      props: z.object({ columns: z.number().int().min(1).max(4) }),
      slots: ["default"],
      description: "Responsive columns for cards and metrics.",
    },
    Metric: {
      props: z.object({ label: z.string(), value: z.string(), detail: z.string() }),
      description: "A dashboard statistic, price or summary value.",
    },
    Table: {
      props: z.object({
        caption: z.string(),
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
      }),
      description: "A data table with column headers and string cells.",
    },
    Button: {
      props: z.object({ label: z.string(), prompt: promptSchema.optional() }),
      description: "Request a revision using the supplied prompt.",
    },
    FeedbackForm: {
      props: z.object({ label: z.string(), value: z.string().optional() }),
      description: "Ask the user what they would change in this view.",
    },
  },
  actions: {
    reviseUi: {
      params: promptRequestSchema,
      description: "Generate a revised interface from this prompt.",
    },
  },
});

// The upstream catalog validator normalizes element fields and strips `on` in 0.21.4.
// Preserve event bindings with its public schema, narrowed to this application's one action.
const bindingSchema = ActionBindingSchema.omit({ onSuccess: true, onError: true, confirm: true })
  .extend({ action: z.literal("reviseUi") })
  .strict();

const bindingsSchema = z.object({
  elements: z.record(
    z.string(),
    z.object({
      on: z.record(z.string(), z.union([bindingSchema, z.array(bindingSchema)])).optional(),
    }),
  ),
});

export function validateUiSpec(spec: unknown): Spec {
  const validated = catalog.validate(spec);
  if (!validated.success || !validated.data)
    throw new Error("Generated UI failed catalog validation");
  const bindings = bindingsSchema.parse(spec);
  const normalized = validated.data as Spec;

  // Catalog validation permits dynamic props. Validate resolved values against each registered schema too.
  for (const element of Object.values(normalized.elements)) {
    const definition =
      catalog.data.components[element.type as keyof typeof catalog.data.components];
    definition.props.parse(resolveElementProps(element.props, { stateModel: { feedback: "" } }));
  }

  const parsedSpec = {
    ...normalized,
    elements: Object.fromEntries(
      Object.entries(normalized.elements).map(([key, element]) => {
        const on = bindings.elements[key]?.on;
        // The catalog wires its own controls. Saved specs with explicit bindings keep theirs.
        if (
          element.type === "Button" &&
          typeof element.props["prompt"] === "string" &&
          !on?.["press"]
        )
          return [
            key,
            {
              ...element,
              on: {
                ...on,
                press: { action: "reviseUi", params: { prompt: element.props["prompt"] } },
              },
            },
          ];
        if (
          element.type === "FeedbackForm" &&
          element.props["value"] === undefined &&
          !on?.["submit"]
        )
          return [
            key,
            {
              ...element,
              props: { ...element.props, value: { $bindState: "/feedback" } },
              on: {
                ...on,
                submit: { action: "reviseUi", params: { prompt: { $state: "/feedback" } } },
              },
            },
          ];
        return [key, { ...element, ...bindings.elements[key] }];
      }),
    ),
  };

  const validation = validateSpec(parsedSpec);
  if (!validation.valid)
    throw new Error(
      validation.issues.find((issue) => issue.severity === "error")?.message ??
        "Generated UI has invalid element references.",
    );
  return parsedSpec;
}

const revisionButton = z.object({
  type: z.literal("Button"),
  visible: z.literal(true).optional(),
  on: z.object({ press: z.object({ action: z.literal("reviseUi"), params: promptRequestSchema }) }),
});

const revisionForm = z.object({
  type: z.literal("FeedbackForm"),
  visible: z.literal(true).optional(),
  props: z.object({ value: z.object({ $bindState: z.literal("/feedback") }) }),
  on: z.object({
    submit: z.object({
      action: z.literal("reviseUi"),
      params: z.object({ prompt: z.object({ $state: z.literal("/feedback") }) }),
    }),
  }),
});

/** Require usable controls on new responses while allowing older saved specs to reopen. */
export function validateGeneratedUi(spec: unknown): Spec {
  const ui = validateUiSpec(spec);
  const root = ui.elements[ui.root];
  if (root?.type !== "Card" || root.repeat || (root.visible !== undefined && root.visible !== true))
    throw new Error("Generated UI needs a visible root card that displays its children.");
  const children = root.children?.map((key) => ui.elements[key]) ?? [];
  if (!children.some((element) => revisionButton.safeParse(element).success))
    throw new Error("Generated UI is missing a working revision button.");
  if (!children.some((element) => revisionForm.safeParse(element).success))
    throw new Error("Generated UI is missing a working revision form.");
  return ui;
}

export const committedUiSchema = z.object({
  generationId: z.string().uuid(),
  chunkCount: z.number().int().nonnegative(),
  spec: z.unknown().transform(validateUiSpec),
});

export const conversationSchema = z.array(
  z
    .object({ generationId: z.uuid(), prompt: promptSchema, ui: committedUiSchema.optional() })
    .refine(
      (turn) => !turn.ui || turn.ui.generationId === turn.generationId,
      "Saved response has an invalid generation identity",
    ),
);
export type Conversation = z.infer<typeof conversationSchema>;

export type UiRequest = z.infer<typeof requestSchema>;
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export type CommittedUi = z.infer<typeof committedUiSchema>;

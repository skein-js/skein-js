import {
  ActionBindingSchema,
  defineCatalog,
  resolveElementProps,
  validateSpec,
  type Spec,
} from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const promptSchema = z.string().trim().min(1).max(2000);
export const requestSchema = z.object({ prompt: promptSchema }).strict();
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
      description: "A data table with illustrative values.",
    },
    Button: {
      props: z.object({ label: z.string() }),
      description: "Request a revision. Bind press to reviseUi.",
    },
    FeedbackForm: {
      props: z.object({ label: z.string(), value: z.string() }),
      description:
        "Bind value to /feedback with $bindState. Bind submit to reviseUi with prompt from $state /feedback.",
    },
  },
  actions: {
    reviseUi: { params: requestSchema, description: "Generate a revised plan from this prompt." },
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
      Object.entries(normalized.elements).map(([key, element]) => [
        key,
        { ...element, ...bindings.elements[key] },
      ]),
    ),
  };
  if (!validateSpec(parsedSpec).valid)
    throw new Error("Generated UI has invalid element references");
  return parsedSpec;
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
export type CommittedUi = z.infer<typeof committedUiSchema>;

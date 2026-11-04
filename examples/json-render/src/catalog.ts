import { ActionBindingSchema, defineCatalog, validateSpec, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const requestSchema = z.object({ prompt: z.string().trim().min(1).max(2000) }).strict();
export const decisionSchema = z
  .object({ generationId: z.string().uuid(), approved: z.boolean() })
  .strict();

export const catalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({ title: z.string() }),
      slots: ["default"],
      description: "A plan card. Use as the root.",
    },
    Text: { props: z.object({ text: z.string() }), description: "Plain text, never HTML." },
    TaskList: {
      props: z.object({ tasks: z.array(z.string()) }),
      description: "A short list of concrete steps.",
    },
    Button: {
      props: z.object({ label: z.string() }),
      description: "Request a revision. Bind press to revisePlan.",
    },
    FeedbackForm: {
      props: z.object({ label: z.string(), value: z.string() }),
      description:
        "Bind value to /feedback with $bindState. Bind submit to revisePlan with prompt from $state /feedback.",
    },
  },
  actions: {
    revisePlan: { params: requestSchema, description: "Generate a revised plan from this prompt." },
  },
});

// The upstream catalog validator normalizes element fields and strips `on` in 0.21.4.
// Preserve event bindings with its public schema, narrowed to this application's one action.
const bindingSchema = ActionBindingSchema.omit({ onSuccess: true, onError: true, confirm: true })
  .extend({ action: z.literal("revisePlan") })
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

export type PlanRequest = z.infer<typeof requestSchema>;
export type CommittedUi = z.infer<typeof committedUiSchema>;

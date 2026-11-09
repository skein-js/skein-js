import {
  fromJsonSchema,
  inputRequired,
  inputResponse,
  ProtocolError,
  ProtocolErrorCode,
  type InputRequest,
  type InputRequests,
} from "@modelcontextprotocol/server";
import type { RunResult } from "@skein-js/core";
import { z } from "zod";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";

const objectSchema = z.record(z.unknown());
const relaySchema = z.object({
  message: z.string(),
  mode: z.enum(["form", "url"]).default("form"),
  requestedSchema: objectSchema.optional(),
  requested_schema: objectSchema.optional(),
  url: z.string().optional(),
});
const actionSchema = z.object({
  name: z.string(),
  args: objectSchema,
  description: z.string().optional(),
});
const reviewSchema = z.object({
  actionName: z.string().optional(),
  action_name: z.string().optional(),
  allowedDecisions: z.array(z.enum(["approve", "edit", "reject", "respond"])).optional(),
  allowed_decisions: z.array(z.enum(["approve", "edit", "reject", "respond"])).optional(),
});
type Question = { key: string; request: InputRequest };
type Review = { action: z.infer<typeof actionSchema>; allowed: string[]; question: Question };
type Prompt =
  | { id: string; kind: "string"; questions: Question[] }
  | { id: string; kind: "relay"; questions: Question[]; originalKeys: string[] }
  | {
      id: string;
      kind: "review";
      questions: Question[];
      reviews: Review[];
      camelCase: boolean;
      perCallSchema?: Record<string, unknown>;
    };

export function invalidMcpAnswer(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function form(message: string, schema: Record<string, unknown>): InputRequest {
  // The SDK converts and validates the restricted MCP form schema. It never fetches references.
  return inputRequired.elicit({ message, requestedSchema: fromJsonSchema(schema) });
}

function relayRequest(value: unknown): InputRequest {
  const request = relaySchema.parse(value);
  if (request.mode === "form") {
    const schema = request.requestedSchema ?? request.requested_schema;
    if (!schema) throw new Error("A form needs requestedSchema.");
    return form(request.message, schema);
  }
  const url = new URL(request.url ?? "");
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    (request.url?.length ?? 0) > 4096 ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error(
      "URL elicitation requires HTTPS or HTTP on localhost, without URL credentials.",
    );
  return inputRequired.elicitUrl({ message: request.message, url: request.url! });
}

function reviewQuestion(
  key: string,
  action: z.infer<typeof actionSchema>,
  allowed: string[],
): Review {
  if (allowed.length === 0) throw new Error("No supported review decision is available.");
  const properties: Record<string, unknown> = { decision: { type: "string", enum: allowed } };
  if (allowed.includes("edit"))
    properties["args"] = { type: "string", default: JSON.stringify(action.args) };
  if (allowed.includes("reject") || allowed.includes("respond"))
    properties["message"] = { type: "string" };
  return {
    action,
    allowed,
    question: {
      key,
      request: form(action.description || `Run ${action.name}?`, {
        type: "object",
        properties,
        required: ["decision"],
      }),
    },
  };
}

/** Only translates established interrupt payloads; the graph still decides when to ask. */
export function mcpQuestions(result: RunResult): {
  prompts: Prompt[];
  inputRequests: InputRequests;
} {
  const interrupts = Object.values(result.interrupts ?? {}).flat();
  const prompts = interrupts.map((interrupt, index): Prompt => {
    if (!interrupt.id) throw new Error("The interrupt has no resumable ID.");
    const value = interrupt.value;
    const digest = sha256Hex(canonicalJson(value)).slice(0, 16);
    if (typeof value === "string")
      return {
        id: interrupt.id,
        kind: "string",
        questions: [
          {
            key: `answer-${digest}`,
            request: form(value, {
              type: "object",
              properties: { response: { type: "string" } },
              required: ["response"],
            }),
          },
        ],
      };
    const payload = objectSchema.parse(value);
    if (payload["type"] === "mcp_elicitation") {
      const requests = payload["requests"];
      const entries: [string, unknown][] = Array.isArray(requests)
        ? requests.map((entry) => {
            const parsed = objectSchema.parse(entry);
            return [z.string().min(1).parse(parsed["key"]), entry];
          })
        : Object.entries(objectSchema.parse(requests));
      if (entries.length === 0) throw new Error("The interrupt has no questions.");
      const prefix = interrupts.length === 1 ? "" : `${digest}.${index + 1}/`;
      return {
        id: interrupt.id,
        kind: "relay",
        originalKeys: entries.map(([key]) => key),
        questions: entries.map(([key, entry]) => ({
          key: prefix + key,
          request: relayRequest(entry),
        })),
      };
    }
    const perCall = payload["type"] === "tool_approval";
    const camelCase = "actionRequests" in payload;
    const actions = perCall
      ? [actionSchema.parse(payload)]
      : z
          .array(actionSchema)
          .nonempty()
          .parse(payload[camelCase ? "actionRequests" : "action_requests"]);
    const reviews = perCall
      ? []
      : z.array(reviewSchema).parse(payload[camelCase ? "reviewConfigs" : "review_configs"]);
    const responseSchema = objectSchema
      .optional()
      .parse((interrupt as unknown as Record<string, unknown>)["response_schema"]);
    const proposed = actions.map((action, actionIndex) => {
      const config = reviews.find(
        (review) => (review.actionName ?? review.action_name) === action.name,
      );
      // In per-call mode the schema, not a server default, selects the allowed decisions.
      const allowed = perCall
        ? decisionsFromSchema(responseSchema)
        : (config?.allowedDecisions ?? config?.allowed_decisions ?? []);
      return reviewQuestion(`review-${digest}.${index + 1}.${actionIndex + 1}`, action, allowed);
    });
    return {
      id: interrupt.id,
      kind: "review",
      camelCase,
      reviews: proposed,
      questions: proposed.map((review) => review.question),
      ...(perCall ? { perCallSchema: responseSchema ?? {} } : {}),
    };
  });
  return {
    prompts,
    inputRequests: Object.fromEntries(
      prompts.flatMap((prompt) =>
        prompt.questions.map((question) => [question.key, question.request]),
      ),
    ),
  };
}

function decisionsFromSchema(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) throw new Error("Tool review needs its response schema.");
  // Read offered discriminator constants only; validation itself remains with the SDK validator.
  const offered = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const properties = record["properties"] as Record<string, unknown> | undefined;
    const discriminator = properties?.["type"] as Record<string, unknown> | undefined;
    if (typeof discriminator?.["const"] === "string") offered.add(discriminator["const"]);
    if (Array.isArray(discriminator?.["enum"]))
      for (const choice of discriminator["enum"])
        if (typeof choice === "string") offered.add(choice);
    for (const child of Object.values(record)) visit(child);
  };
  visit(schema);
  return ["approve", "edit", "reject", "respond"].filter((decision) => offered.has(decision));
}

async function validateContent(schema: Record<string, unknown>, content: unknown): Promise<void> {
  const validation = await fromJsonSchema(schema)["~standard"].validate(content);
  if (validation.issues) invalidMcpAnswer("Form content does not match requestedSchema.");
}

export async function mcpResumeAnswers(
  prompts: Prompt[],
  responses: Record<string, unknown> | undefined,
): Promise<{ missing: true } | { resume: Record<string, unknown> } | { error: string }> {
  let missing = false;
  const answers = new Map<
    string,
    { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
  >();
  for (const { key, request } of prompts.flatMap((prompt) => prompt.questions)) {
    const response = inputResponse(responses, key);
    if (response.kind === "missing") {
      if (responses && Object.hasOwn(responses, key))
        invalidMcpAnswer("Invalid elicitation answer.");
      missing = true;
      continue;
    }
    if (response.kind !== "elicit") invalidMcpAnswer("Expected an elicitation answer.");
    if (request.method !== "elicitation/create") throw new Error("Unexpected input request.");
    if (response.action === "accept") {
      if (request.params.mode === "url") {
        if (response.content !== undefined)
          invalidMcpAnswer("A URL elicitation answer must not contain content.");
      } else await validateContent(request.params.requestedSchema, response.content);
    }
    answers.set(key, response);
  }
  if (missing) return { missing: true };
  const resume: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const prompt of prompts) {
    if (prompt.kind === "relay") {
      resume[prompt.id] = {
        responses: Object.fromEntries(
          prompt.questions.map((question, index) => [
            prompt.originalKeys[index],
            answers.get(question.key),
          ]),
        ),
      };
    } else if (prompt.kind === "string") {
      const answer = answers.get(prompt.questions[0]!.key)!;
      if (answer.action !== "accept")
        return {
          error: `The request for input was ${answer.action === "cancel" ? "cancelled" : "declined"}.`,
        };
      resume[prompt.id] = answer.content!["response"];
    } else {
      const decisions = prompt.reviews.map((review) => {
        const answer = answers.get(review.question.key)!;
        if (
          answer.action === "cancel" ||
          (answer.action === "decline" && !review.allowed.includes("reject"))
        )
          return undefined;
        const content = answer.content ?? {};
        const decision = answer.action === "decline" ? "reject" : content["decision"];
        if (typeof decision !== "string" || !review.allowed.includes(decision))
          invalidMcpAnswer("The decision is not allowed for this tool.");
        const message = content["message"];
        if (decision === "respond" && (typeof message !== "string" || !message.trim()))
          invalidMcpAnswer("A respond decision requires a message.");
        if (decision !== "edit")
          return {
            type: decision,
            ...(typeof message === "string" && message.trim() ? { message } : {}),
          };
        let args: unknown;
        try {
          args = JSON.parse(z.string().parse(content["args"]));
        } catch {
          invalidMcpAnswer("Edited arguments must be a JSON object.");
        }
        if (!objectSchema.safeParse(args).success)
          invalidMcpAnswer("Edited arguments must be a JSON object.");
        return {
          type: "edit",
          [prompt.camelCase ? "editedAction" : "edited_action"]: { name: review.action.name, args },
        };
      });
      if (decisions.some((decision) => decision === undefined))
        return { error: "The request for input was cancelled." };
      const decision = prompt.perCallSchema ? decisions[0] : { decisions };
      if (prompt.perCallSchema && Object.keys(prompt.perCallSchema).length)
        await validateContent(prompt.perCallSchema, decision);
      resume[prompt.id] = decision;
    }
  }
  return { resume };
}

import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type { AuthEngine } from "@skein-js/core";
import { SkeinHttpError } from "@skein-js/core";
import { createExpressServer } from "@skein-js/express";
import { embedSqliteGraphs } from "@skein-js/local";

import {
  buildMeetingAssistant,
  defaultProjectContext,
  type MeetingAgentOptions,
} from "./meeting-agent.js";
import { createModelSession } from "./model-session.js";
import { buildWorkflow } from "./workflow.js";

function hasLaunchCredential(authorization: string | undefined, token: string): boolean {
  const supplied = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function bearerAuth(token: string): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled: true,
    async authenticate(request) {
      if (!hasLaunchCredential(request.headers.get("authorization") ?? undefined, token))
        throw SkeinHttpError.unauthorized("A launch credential is required.");
      return {
        user: {
          identity: "local-user",
          display_name: "Local user",
          is_authenticated: true,
          permissions: [],
        },
        scopes: [],
      };
    },
    async authorize({ value }) {
      return { value };
    },
    matchesFilters() {
      return true;
    },
  };
}

export async function startWorkflowServer(
  directory: string,
  token: string,
  options: MeetingAgentOptions = {},
) {
  if (!token) throw new Error("The host must supply a per-launch bearer token.");
  const session = createModelSession();
  const agentOptions = { ...options, createModel: options.createModel ?? session.createModel };
  const embedded = await embedSqliteGraphs(
    {
      workflow: buildWorkflow(directory, agentOptions),
      assistant: buildMeetingAssistant(agentOptions),
    },
    { sqlitePath: join(directory, "state.sqlite"), overrides: { auth: bearerAuth(token) } },
  );
  try {
    const preference = await embedded.deps.store.store.get(["meeting-workspace"], "model");
    if (!options.fixture) await session.initialize(preference?.value);
    if (!(await embedded.deps.store.store.get(["meeting-workspace"], "project")))
      await embedded.deps.store.store.put(["meeting-workspace"], "project", {
        context: defaultProjectContext,
      });
    const server = await createExpressServer({
      deps: embedded.deps,
      cors: {
        origin: ["null", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"],
      },
    });
    // Credentials belong to the host, outside Agent Protocol resources and checkpointed input.
    server.app.get("/app/model", (request, response) => {
      if (!hasLaunchCredential(request.headers.authorization, token)) {
        response.status(401).json({ message: "Launch credential required." });
        return;
      }
      response.json({ ...session.status(), fixture: Boolean(options.fixture) });
    });
    server.app.post("/app/model", async (request, response) => {
      if (!hasLaunchCredential(request.headers.authorization, token)) {
        response.status(401).json({ message: "Launch credential required." });
        return;
      }
      try {
        const status = await session.connect(request.body);
        await embedded.deps.store.store.put(["meeting-workspace"], "model", {
          provider: status.provider,
          model: status.model,
          project: status.project,
          location: status.location,
          baseUrl: status.baseUrl,
        });
        response.json(status);
      } catch (error) {
        response.status(400).json({
          message: error instanceof Error ? error.message : "The model provider could not connect.",
        });
      }
    });
    server.app.delete("/app/model", (request, response) => {
      if (!hasLaunchCredential(request.headers.authorization, token)) {
        response.status(401).json({ message: "Launch credential required." });
        return;
      }
      session.disconnect();
      response.json(session.status());
    });
    const bound = await server.listen(0, "127.0.0.1");
    const address = bound.address();
    if (!address || typeof address === "string") throw new Error("No loopback port assigned");
    return {
      url: `http://127.0.0.1:${address.port}`,
      async dispose() {
        await server.close();
        await embedded.dispose();
      },
    };
  } catch (error) {
    await embedded.dispose();
    throw error;
  }
}

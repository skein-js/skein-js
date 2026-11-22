import { describe, expect, it } from "vitest";

import { generateImmediateText, rendererMetadata } from "./generation-fixture.js";
import { startHarness } from "./test-harness.js";
import { parseSavedUi, uiSurfaceIds } from "./ui-contract.js";
import { createUiSession } from "./ui-session.js";

describe("A2UI authorization and application boundaries", () => {
  it("enforces ownership for state, stream, cancellation and resume", async () => {
    const harness = await startHarness(generateImmediateText);
    const alice = harness.clientFor("alice");
    const session = createUiSession(alice, rendererMetadata);

    try {
      await session.generate("Alice's canvas");
      const { threadId, runId } = session.read();
      const root = "/threads/" + threadId;

      for (const [path, method, body] of [
        [root + "/state", "GET", undefined],
        [root + "/runs/" + runId + "/stream", "GET", undefined],
        [root + "/runs/" + runId + "/cancel", "POST", {}],
        [
          root + "/runs",
          "POST",
          { assistant_id: "ui-playground", input: null, command: { resume: { approved: true } } },
        ],
      ] as const) {
        const response = await fetch(harness.url + path, {
          method,
          headers: { "x-user": "bob", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status, path).toBe(404);
      }

      expect((await fetch(harness.url + root + "/state")).status).toBe(401);
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it("does not admit a competing start while an canvas awaits approval", async () => {
    const harness = await startHarness(generateImmediateText);
    const client = harness.clientFor();
    const session = createUiSession(client, rendererMetadata);

    try {
      await session.generate("Preserve the pending review");
      const saved = session.read();
      const before = await client.runs.list(saved.threadId!);
      await expect(
        harness.clientFor().runs.create(saved.threadId!, "ui-playground", {
          input: {
            request: { kind: "generate", prompt: "A competing tab", metadata: rendererMetadata() },
          },
          multitaskStrategy: "reject",
        }),
      ).rejects.toThrow();
      expect(await client.runs.list(saved.threadId!)).toHaveLength(before.length);
      expect((await client.threads.getState(saved.threadId!)).values["ui"]).toEqual(saved.ui);
      await session.decide(true);
      await expect(
        harness.clientFor().runs.create(saved.threadId!, "ui-playground", {
          input: null,
          command: { resume: { generationId: saved.ui!.generationId, approved: false } },
        }),
      ).rejects.toThrow();
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it("excludes checkpoint UI and approval channels from ordinary input", async () => {
    const harness = await startHarness(generateImmediateText);

    try {
      const client = harness.clientFor();
      const thread = await client.threads.create();
      await client.runs.wait(thread.thread_id, "ui-playground", {
        input: {
          request: { kind: "generate", prompt: "A real request", metadata: rendererMetadata() },
          ui: { schemaVersion: 1, bootstrapMessages: "forged" },
          approved: true,
        },
      });
      const state = await client.threads.getState(thread.thread_id);
      expect(parseSavedUi(state.values["ui"]).bootstrapMessages).toHaveLength(3);
      expect(state.values["approved"]).toBeNull();
      expect(state.tasks.flatMap((task) => task.interrupts)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it.each(["stale", "malformed"])(
    "rejects a %s approval without changing the saved UI",
    async (kind) => {
      const harness = await startHarness(generateImmediateText);
      const client = harness.clientFor();
      const session = createUiSession(client, rendererMetadata);

      try {
        await session.generate("Review me");
        const saved = session.read();

        const run = await client.runs.create(saved.threadId!, "ui-playground", {
          input: null,
          command: {
            resume: {
              generationId: kind === "stale" ? crypto.randomUUID() : saved.ui!.generationId,
              approved: kind === "malformed" ? "yes" : true,
            },
          },
        });
        await client.runs.join(saved.threadId!, run.run_id);
        expect((await client.runs.get(saved.threadId!, run.run_id)).status).toBe("error");
        const state = await client.threads.getState(saved.threadId!);
        expect(state.values["ui"]).toEqual(saved.ui);
        expect(state.values["approved"]).toBeNull();
      } finally {
        session.dispose();
        await harness.close();
      }
    },
  );

  it("rejects stale actions, forged source components and mismatched submitted form state", async () => {
    const harness = await startHarness(generateImmediateText);
    const client = harness.clientFor();
    const session = createUiSession(client, rendererMetadata);

    try {
      await session.generate("My trip");
      await session.decide(true);
      const saved = session.read();
      const preferenceId = uiSurfaceIds(saved.ui!.generationId).controls;

      for (const failure of ["generation", "source", "data-model"] as const) {
        const run = await client.runs.create(saved.threadId!, "ui-playground", {
          input: {
            request: {
              kind: "action",
              generationId: failure === "generation" ? crypto.randomUUID() : saved.ui!.generationId,
              message: {
                version: "1.0",
                action: {
                  name: "reviseUi",
                  surfaceId: preferenceId,
                  sourceComponentId: failure === "source" ? "unknown" : "revise",
                  timestamp: new Date().toISOString(),
                  context: { prompt: "New chat" },
                },
              },
              metadata: {
                ...rendererMetadata(),
                a2uiRendererDataModel: {
                  version: "1.0",
                  surfaces: { [preferenceId]: { feedback: "Different input" } },
                },
              },
            },
          },
        });
        await client.runs.join(saved.threadId!, run.run_id);
        expect((await client.runs.get(saved.threadId!, run.run_id)).status).toBe("error");
        expect((await client.threads.getState(saved.threadId!)).values["ui"]).toEqual(saved.ui);
      }
    } finally {
      session.dispose();
      await harness.close();
    }
  });
});

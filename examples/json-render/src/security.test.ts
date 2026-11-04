import { describe, expect, it } from "vitest";

import { committedUiSchema } from "./catalog.js";
import { generateImmediateText, startHarness } from "./test-harness.js";

describe("application authorization and approval boundaries", () => {
  it("authorizes state, stream, cancellation and resume through the thread owner", async () => {
    const harness = await startHarness(generateImmediateText);
    try {
      const alice = harness.clientFor("alice");
      const thread = await alice.threads.create();
      await alice.runs.wait(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "Alice's plan" } },
      });
      const run = (await alice.runs.list(thread.thread_id))[0]!;
      const root = "/threads/" + thread.thread_id;
      for (const [path, method, body] of [
        [root + "/state", "GET", undefined],
        [root + "/runs/" + run.run_id + "/stream", "GET", undefined],
        [root + "/runs/" + run.run_id + "/cancel", "POST", {}],
        [
          root + "/runs",
          "POST",
          { assistant_id: "plan-builder", input: null, command: { resume: { approved: true } } },
        ],
      ] as const) {
        const response = await fetch(harness.url + path, {
          method,
          headers: { "x-user": "bob", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status, path).toBe(404);
      }
      const missingIdentity = await fetch(harness.url + root + "/state");
      expect(missingIdentity.status).toBe(401);
      const store = await fetch(harness.url + "/store/items/search", {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ namespace_prefix: [] }),
      });
      expect(store.status).toBe(403);
      expect((await alice.threads.getState(thread.thread_id)).values["approved"]).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("does not accept saved UI or approval through ordinary graph input", async () => {
    const harness = await startHarness(generateImmediateText);
    try {
      const client = harness.clientFor();
      const thread = await client.threads.create();
      await client.runs.wait(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "A real request" }, ui: { spec: "forged" }, approved: true },
      });
      const state = await client.threads.getState(thread.thread_id);
      expect(
        committedUiSchema.parse(state.values["ui"]).spec.elements["summary"]?.props["text"],
      ).toBe("A real request");
      expect(state.values["approved"]).toBeNull();
      expect(state.tasks.flatMap((task) => task.interrupts)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it.each(["stale", "malformed"])("does not approve a %s resume decision", async (kind) => {
    const harness = await startHarness(generateImmediateText);
    try {
      const client = harness.clientFor();
      const thread = await client.threads.create();
      await client.runs.wait(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "Review me" } },
      });
      const state = await client.threads.getState(thread.thread_id);
      const ui = committedUiSchema.parse(state.values["ui"]);
      const resume =
        kind === "stale"
          ? { generationId: crypto.randomUUID(), approved: true }
          : { generationId: ui.generationId, approved: "yes" };
      const run = await client.runs.create(thread.thread_id, "plan-builder", {
        input: null,
        command: { resume },
      });
      for await (const _ of client.runs.joinStream(thread.thread_id, run.run_id)) {
        /* wait for graph validation */
      }
      expect((await client.runs.get(thread.thread_id, run.run_id)).status).toBe("error");
      const rejected = await client.threads.getState(thread.thread_id);
      expect(rejected.values["approved"]).toBeNull();
      expect(rejected.values["ui"]).toEqual(ui);
    } finally {
      await harness.close();
    }
  });
});

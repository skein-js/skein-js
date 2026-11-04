import { setTimeout as pause } from "node:timers/promises";

import { Client } from "@langchain/langgraph-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { committedUiSchema } from "./catalog.js";
import { demoSpecStream } from "./generation.js";
import { addRunIdempotency } from "./plan-client.js";
import { createPlanSession } from "./plan-session.js";
import { generateImmediateText, startHarness } from "./test-harness.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("plan session over the official HTTP SDK", () => {
  it("retries a lost run-creation response without generating or approving twice", async () => {
    let generations = 0;
    const harness = await startHarness(async function* (request, signal) {
      generations++;
      yield* generateImmediateText(request, signal);
    });
    let lostResponse = false;
    const creationKeys: (string | null)[] = [];
    const client = new Client<Record<string, unknown>>({
      apiUrl: harness.url,
      apiKey: null,
      defaultHeaders: { "x-user": "demo-user" },
      onRequest: addRunIdempotency,
      callerOptions: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init);
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (init?.method === "POST" && /\/threads\/[^/]+\/runs$/.test(new URL(url).pathname)) {
            creationKeys.push(new Headers(init.headers).get("Idempotency-Key"));
            if (!lostResponse) {
              lostResponse = true;
              // Let the accepted run finish before its response is lost.
              // An active-run rejection alone cannot protect this retry.
              const run = await response.clone().json();
              await harness.clientFor().runs.join(run.thread_id, run.run_id);
              throw new TypeError("fetch failed");
            }
          }
          return response;
        },
      },
    });
    const session = createPlanSession(client);
    try {
      await session.generate({ prompt: "Create exactly one plan" });
      expect(session.read()).toMatchObject({ busy: false, error: null });
      expect(session.read().review).not.toBeNull();
      expect(generations).toBe(1);
      expect(creationKeys).toHaveLength(2);
      expect(creationKeys[0]).toBeTruthy();
      expect(creationKeys[1]).toBe(creationKeys[0]);
      expect(await client.runs.list(session.read().threadId!)).toHaveLength(1);

      // Each later operation gets a new key, even when prompts and decisions repeat.
      lostResponse = false;
      await session.decide(true);
      expect(session.read()).toMatchObject({ approved: true, error: null });
      expect(creationKeys[2]).not.toBe(creationKeys[0]);
      expect(creationKeys[3]).toBe(creationKeys[2]);
      await session.generate({ prompt: "Create exactly one plan" });
      expect(session.read().review).not.toBeNull();
      await session.decide(true);
      expect(session.read()).toMatchObject({ approved: true, error: null });
      expect(generations).toBe(2);
      expect(new Set(creationKeys).size).toBe(4);
      expect(await client.runs.list(session.read().threadId!)).toHaveLength(4);
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it.each(["prefix", "interior", "tail", "all", "duplicates"])(
    "reconciles %s event delivery with saved state",
    async (damage) => {
      let generations = 0;
      const harness = await startHarness(async function* (request, signal) {
        generations++;
        yield* generateImmediateText(request, signal);
      });
      try {
        const client = new Client<Record<string, unknown>>({
          apiUrl: harness.url,
          apiKey: null,
          defaultHeaders: { "x-user": "demo-user" },
          callerOptions: {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const response = await fetch(input, init);
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (!new URL(url).pathname.endsWith("/stream") || !response.ok) return response;
              // Fault injection on real SSE frames; production parsing stays in the SDK.
              const blocks = (await response.text()).split("\n\n");
              const custom = blocks.filter((block) => block.includes('"type":"json-render"'));
              let index = -1;
              const filtered = blocks.flatMap((block) => {
                if (!block.includes('"type":"json-render"')) return [block];
                index++;
                if (
                  damage === "all" ||
                  (damage === "prefix" && index === 0) ||
                  (damage === "interior" && index === 3) ||
                  (damage === "tail" && index >= custom.length - 2)
                )
                  return [];
                return damage === "duplicates" ? [block, block] : [block];
              });
              return new Response(filtered.join("\n\n"), {
                status: response.status,
                headers: { "content-type": "text/event-stream" },
              });
            },
          },
        });
        const session = createPlanSession(client);
        const recovered: string[] = [];
        const unsubscribe = session.subscribe(() => {
          if (session.read().recovery) recovered.push(session.read().recovery!);
        });
        await session.generate({ prompt: "A short plan" });
        const snapshot = session.read();
        expect(snapshot).toMatchObject({ busy: false, preview: false, error: null });
        expect(snapshot.review).not.toBeNull();
        const saved = await client.threads.getState(snapshot.threadId!);
        expect(snapshot.spec).toEqual(committedUiSchema.parse(saved.values["ui"]).spec);
        expect(snapshot.spec?.elements["tasks"]?.props["tasks"]).toHaveLength(3);
        if (damage === "prefix" || damage === "interior")
          expect(recovered.length).toBeGreaterThan(0);
        expect(generations).toBe(1);
        unsubscribe();
        session.dispose();
      } finally {
        await harness.close();
      }
    },
  );

  it.each([false, true])(
    "reconnects the same run when checkpoint already exists: %s",
    async (finishFirst) => {
      const continuation = gate();
      let generations = 0;
      const harness = await startHarness(async function* (request) {
        generations++;
        const text = demoSpecStream(request);
        const split = text.indexOf("\n", text.indexOf("\n") + 1) + 1;
        yield text.slice(0, split);
        await continuation.promise;
        yield text.slice(split);
      });
      const client = harness.clientFor();
      const session = createPlanSession(client);
      try {
        const running = session.generate({ prompt: "Reconnect safely" });
        await expect.poll(() => session.read().preview).toBe(true);
        const { threadId, runId } = session.read();
        session.disconnect();
        await running;
        expect((await client.runs.get(threadId!, runId!)).status).toBe("running");
        if (finishFirst) {
          continuation.release();
          await client.runs.join(threadId!, runId!);
        }
        const reconnecting = session.reconnect();
        if (!finishFirst) continuation.release();
        await reconnecting;
        expect(session.read()).toMatchObject({ busy: false, error: null, threadId, runId });
        expect(session.read().review).not.toBeNull();
        expect(generations).toBe(1);
      } finally {
        continuation.release();
        session.dispose();
        await harness.close();
      }
    },
  );

  it("restores after actual bus eviction without executing the graph again", async () => {
    vi.stubEnv("SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN", "2");
    vi.stubEnv("SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS", "1");
    let generations = 0;
    const harness = await startHarness(async function* (request, signal) {
      generations++;
      yield* generateImmediateText(request, signal);
    });
    try {
      const client = harness.clientFor();
      const first = await client.threads.create();
      await client.runs.wait(first.thread_id, "plan-builder", {
        input: { request: { prompt: "Remember this plan" } },
      });
      const firstRun = (await client.runs.list(first.thread_id))[0]!;
      const second = await client.threads.create();
      await client.runs.wait(second.thread_id, "plan-builder", {
        input: { request: { prompt: "Evict old frames" } },
      });
      const replay = [];
      for await (const event of client.runs.joinStream(first.thread_id, firstRun.run_id))
        replay.push(event);
      expect(replay.filter((event) => event.event === "custom")).toEqual([]);
      const reopened = createPlanSession(harness.clientFor());
      await reopened.open(first.thread_id);
      expect(reopened.read().spec?.elements["summary"]?.props["text"]).toBe("Remember this plan");
      expect(reopened.read().review).not.toBeNull();
      expect(generations).toBe(2);
      reopened.dispose();
    } finally {
      await harness.close();
    }
  });

  it("keeps the last validated checkpoint when generation fails or is cancelled", async () => {
    const harness = await startHarness(async function* (request, signal) {
      if (request.prompt === "fail") {
        yield "invalid output";
        return;
      }
      if (request.prompt === "slow") {
        yield demoSpecStream(request).slice(0, 400);
        await pause(20_000, undefined, { signal });
      }
      yield* generateImmediateText(request, signal);
    });
    const session = createPlanSession(harness.clientFor());
    try {
      await session.generate({ prompt: "Keep this saved" });
      const baseline = structuredClone(session.read().ui);
      await session.decide(false);
      expect(session.read().approved).toBe(false);
      await session.generate({ prompt: "fail" });
      expect(session.read().error).toBeTruthy();
      expect(session.read().ui).toEqual(baseline);
      const running = session.generate({ prompt: "slow" });
      await expect.poll(() => session.read().preview).toBe(true);
      await session.stop();
      await running;
      expect(session.read()).toMatchObject({
        ui: baseline,
        spec: baseline!.spec,
        busy: false,
        preview: false,
        error: null,
      });
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it("ignores delayed restoration for a thread the user has already left", async () => {
    const harness = await startHarness(generateImmediateText);
    const client = harness.clientFor();
    const releaseOld = gate();
    try {
      const first = await client.threads.create();
      const second = await client.threads.create();
      for (const [thread, prompt] of [
        [first, "Old thread"],
        [second, "Current thread"],
      ] as const)
        await client.runs.wait(thread.thread_id, "plan-builder", {
          input: { request: { prompt } },
        });
      const getState = client.threads.getState.bind(client.threads);
      vi.spyOn(client.threads, "getState").mockImplementation(async (threadId) => {
        const state = await getState(threadId);
        if (threadId === first.thread_id) await releaseOld.promise;
        return state;
      });
      const session = createPlanSession(client);
      const old = session.open(first.thread_id);
      await session.open(second.thread_id);
      releaseOld.release();
      await old;
      expect(session.read().threadId).toBe(second.thread_id);
      expect(session.read().spec?.elements["summary"]?.props["text"]).toBe("Current thread");
      session.dispose();
    } finally {
      releaseOld.release();
      await harness.close();
    }
  });

  it("refreshes a checkpoint that commits between reopening state and looking for active runs", async () => {
    const continuation = gate();
    const harness = await startHarness(async function* (request, signal) {
      await continuation.promise;
      yield* generateImmediateText(request, signal);
    });
    const client = harness.clientFor();
    try {
      const thread = await client.threads.create();
      const run = await client.runs.create(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "Committed while reopening" } },
      });
      const getState = client.threads.getState.bind(client.threads);
      vi.spyOn(client.threads, "getState").mockImplementationOnce(async (threadId) => {
        const oldState = await getState(threadId);
        continuation.release();
        await client.runs.join(threadId, run.run_id);
        return oldState;
      });
      const session = createPlanSession(client);
      await session.open(thread.thread_id);
      expect(session.read().spec?.elements["summary"]?.props["text"]).toBe(
        "Committed while reopening",
      );
      expect(session.read().review).not.toBeNull();
      session.dispose();
    } finally {
      continuation.release();
      await harness.close();
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { Client } from "@langchain/langgraph-sdk";
import { MemoryRunEventBus } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { fixtureResponse, generateImmediateText, rendererMetadata } from "./generation-fixture.js";
import { startHarness } from "./test-harness.js";
import { prepareUiRun } from "./ui-client.js";
import { parseSavedUi, uiSurfaceIds, type SavedUi } from "./ui-contract.js";
import { createUiSession } from "./ui-session.js";

function action(
  ui: SavedUi,
  role: "canvas" | "controls" | "notes",
  name: string,
  source: string,
  context: Record<string, unknown>,
) {
  return {
    version: "1.0",
    action: {
      name,
      surfaceId: uiSurfaceIds(ui.generationId)[role],
      sourceComponentId: source,
      timestamp: new Date().toISOString(),
      context,
    },
  };
}

describe("A2UI session over the official HTTP SDK", () => {
  it("streams, approves without regeneration, revises through bound form input, deletes notes and reopens", async () => {
    let generations = 0;

    const harness = await startHarness(async function* (request, signal) {
      generations++;
      yield* generateImmediateText(request, signal);
    });

    const client = harness.clientFor();
    let metadata = rendererMetadata();
    const session = createUiSession(client, () => metadata);
    const reopened = createUiSession(client, rendererMetadata);

    try {
      let previewed = false;
      session.subscribe(() => {
        previewed ||= session.read().preview;
      });
      await session.generate("Explore a coastal city");
      const saved = session.read();
      expect(saved).toMatchObject({ error: null, busy: false });
      expect(saved.review).not.toBeNull();
      expect(previewed).toBe(true);
      expect(saved.ui?.bootstrapMessages).toHaveLength(3);
      await session.decide(true);
      expect(session.read()).toMatchObject({ approved: true, error: null });
      expect(generations).toBe(1);
      const controls = uiSurfaceIds(saved.ui!.generationId).controls;
      metadata = {
        ...metadata,
        a2uiRendererDataModel: {
          version: "1.0",
          surfaces: { [controls]: { feedback: "  Less walking and more markets  " } },
        },
      };
      await session.act(
        action(saved.ui!, "controls", "reviseUi", "revise", {
          prompt: "  Less walking and more markets  ",
        }),
      );
      expect(session.read().error).toBeNull();
      expect(generations).toBe(2);
      expect(session.read().ui?.generationId).not.toBe(saved.ui!.generationId);
      expect((await client.threads.getState(saved.threadId!)).values["prompt"]).toBe(
        "Less walking and more markets",
      );
      await session.decide(false);
      const revised = session.read().ui!;
      metadata = rendererMetadata();
      await session.act(action(revised, "notes", "dismissNotes", "dismiss", {}));
      expect(session.read()).toMatchObject({ approved: false, error: null, review: null });
      expect(session.read().ui?.bootstrapMessages).toHaveLength(2);
      expect(generations).toBe(2);
      const before = (await client.runs.list(saved.threadId!)).length;
      await reopened.open(saved.threadId);
      expect(reopened.read().ui).toEqual(session.read().ui);
      expect(reopened.read().conversation).toEqual(session.read().conversation);
      expect(reopened.read().conversation.map((turn) => turn.prompt)).toEqual([
        "Explore a coastal city",
        "Less walking and more markets",
      ]);
      expect(reopened.read().approved).toBe(false);
      expect(await client.runs.list(saved.threadId!)).toHaveLength(before);
      expect(generations).toBe(2);
    } finally {
      session.dispose();
      reopened.dispose();
      await harness.close();
    }
  });

  it("retries lost generation and resume responses using the same operation keys", async () => {
    let generations = 0;

    const harness = await startHarness(async function* (request, signal) {
      generations++;
      yield* generateImmediateText(request, signal);
    });

    let loseResponse = true;
    const keys: (string | null)[] = [];

    const client = new Client<Record<string, unknown>>({
      apiUrl: harness.url,
      apiKey: null,
      defaultHeaders: { "x-user": "demo-user" },
      onRequest: prepareUiRun,
      callerOptions: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init);

          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

          if (init?.method === "POST" && /\/threads\/[^/]+\/runs$/.test(new URL(url).pathname)) {
            keys.push(new Headers(init.headers).get("Idempotency-Key"));

            if (loseResponse) {
              loseResponse = false;
              const run = await response.clone().json();
              await harness.clientFor().runs.join(run.thread_id, run.run_id);
              throw new TypeError("fetch failed");
            }
          }

          return response;
        },
      },
    });

    const session = createUiSession(client, rendererMetadata);

    try {
      await session.generate("One generation only");
      expect(session.read().error).toBeNull();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      loseResponse = true;
      await session.decide(true);
      expect(session.read()).toMatchObject({ approved: true, error: null });
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys[3]).toBe(keys[2]);
      expect(generations).toBe(1);
      expect(await client.runs.list(session.read().threadId!)).toHaveLength(2);
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it.each(["prefix", "interior", "tail", "all", "duplicates"])(
    "recovers %s delivery from the terminal checkpoint",
    async (damage) => {
      const harness = await startHarness(generateImmediateText);

      const client = new Client<Record<string, unknown>>({
        apiUrl: harness.url,
        apiKey: null,
        defaultHeaders: { "x-user": "demo-user" },
        onRequest: prepareUiRun,
        callerOptions: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init);

            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!new URL(url).pathname.endsWith("/stream") || !response.ok) return response;
            const blocks = (await response.text()).split("\n\n");
            const custom = blocks.filter((block) => block.includes('"type":"a2ui"'));
            let index = -1;

            const filtered = blocks.flatMap((block) => {
              if (!block.includes('"type":"a2ui"')) return [block];
              index++;
              if (
                damage === "all" ||
                (damage === "prefix" && index === 0) ||
                (damage === "interior" && index === 2) ||
                (damage === "tail" && index === custom.length - 1)
              )
                return [];
              return damage === "duplicates" ? [block, block] : [block];
            });
            return new Response(filtered.join("\n\n"), {
              status: response.status,
              headers: response.headers,
            });
          },
        },
      });

      const session = createUiSession(client, rendererMetadata);

      try {
        await session.generate("Recover this trip");
        expect(session.read()).toMatchObject({ error: null, busy: false, preview: false });
        expect(session.read().ui?.bootstrapMessages).toHaveLength(3);
        expect(session.read().view).toEqual(session.read().ui);
        expect(session.read().review).not.toBeNull();
      } finally {
        session.dispose();
        await harness.close();
      }
    },
  );

  it("restores after actual memory event eviction", async () => {
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 2, maxRetainedRuns: 1 });
    const harness = await startHarness(generateImmediateText, { bus });
    const session = createUiSession(harness.clientFor(), rendererMetadata);

    try {
      await session.generate("A saved UI outlives its frames");
      const saved = session.read();
      await session.decide(true);
      const reopened = createUiSession(harness.clientFor(), rendererMetadata);

      try {
        await reopened.open(saved.threadId);
        expect(reopened.read().ui).toEqual(saved.ui);
      } finally {
        reopened.dispose();
      }
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it("pauses observation, reconnects to the same run, and cancels a later run", async () => {
    let release!: () => void;
    let started!: () => void;
    let generations = 0;

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const harness = await startHarness(async function* (request, signal) {
      generations++;
      const text = fixtureResponse(request.prompt, request.generationId);
      yield text.slice(0, 800);
      if (request.prompt === "Reconnect") {
        started();
        await gate;
      } else await pause(20_000, undefined, { signal });
      yield text.slice(800);
    });

    const session = createUiSession(harness.clientFor(), rendererMetadata);

    try {
      const generating = session.generate("Reconnect");
      await ready;
      await pause(30);
      const runId = session.read().runId;
      session.disconnect();
      await generating;
      expect((await harness.clientFor().runs.get(session.read().threadId!, runId!)).status).toBe(
        "running",
      );
      release();
      await session.reconnect();
      expect(session.read().error).toBeNull();
      expect(session.read().runId).toBe(runId);
      expect(generations).toBe(1);
      await session.decide(true);
      const baseline = session.read().ui;
      const pending = session.generate("Cancel");
      while (!session.read().runId) await pause(10);
      await session.stop();
      await pending;
      expect(session.read()).toMatchObject({ busy: false, preview: false, ui: baseline });
      expect(generations).toBe(2);
    } finally {
      release();
      session.dispose();
      await harness.close();
    }
  });

  it.each(["prompt", "revision"] as const)(
    "keeps the previous checkpoint when a %s fails",
    async (source) => {
      const harness = await startHarness(async function* (request, signal) {
        if (request.prompt === "Fail") throw new Error("Provider unavailable");
        yield* generateImmediateText(request, signal);
      });

      const client = harness.clientFor();
      const session = createUiSession(client, rendererMetadata);

      try {
        await session.generate("A valid trip");
        await session.decide(true);
        const baseline = session.read().ui!;
        if (source === "revision")
          await session.act(action(baseline, "canvas", "reviseUi", "refine", { prompt: "Fail" }));
        else await session.generate("Fail");
        expect(session.read().error).toContain("Provider unavailable");
        expect(session.read().ui).toEqual(baseline);
        expect(session.read().view).toEqual(baseline);
        expect((await client.threads.getState(session.read().threadId!)).values["prompt"]).toBe(
          "A valid trip",
        );
      } finally {
        session.dispose();
        await harness.close();
      }
    },
  );

  it("abandons an unsaved preview when the terminal checkpoint cannot be read", async () => {
    const harness = await startHarness(generateImmediateText);
    let failStateReads = false;

    const client = new Client<Record<string, unknown>>({
      apiUrl: harness.url,
      apiKey: null,
      defaultHeaders: { "x-user": "demo-user" },
      onRequest: prepareUiRun,
      callerOptions: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (failStateReads && new URL(url).pathname.endsWith("/state"))
            return new Response(JSON.stringify({ detail: "Checkpoint unavailable" }), {
              status: 403,
            });
          return fetch(input, init);
        },
      },
    });

    const session = createUiSession(client, rendererMetadata);

    try {
      await session.generate("A saved baseline");
      await session.decide(true);
      const baseline = session.read().ui;
      failStateReads = true;
      await session.generate("An uncertain new trip");
      expect(session.read()).toMatchObject({
        ui: baseline,
        view: baseline,
        preview: false,
        busy: false,
        needsRefresh: true,
      });
      expect(session.read().error).toContain("Refresh the thread");
      const before = (await client.runs.list(session.read().threadId!)).length;
      await session.generate("Do not repeat uncertain work");
      expect(await client.runs.list(session.read().threadId!)).toHaveLength(before);
      failStateReads = false;
      await session.open(session.read().threadId);
      expect(session.read().error).toBeNull();
      expect(session.read().ui?.generationId).not.toBe(baseline!.generationId);
      expect(session.read().review).not.toBeNull();
    } finally {
      session.dispose();
      await harness.close();
    }
  });

  it("restores a pending review after SQLite closes and reopens with fresh event history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skein-a2ui-"));
    const sqlitePath = join(directory, "trips.sqlite");
    let generations = 0;

    const generator = async function* (...args: Parameters<typeof generateImmediateText>) {
      generations++;
      yield* generateImmediateText(...args);
    };

    let harness = await startHarness(generator, { sqlitePath });
    let session = createUiSession(harness.clientFor(), rendererMetadata);

    try {
      await session.generate("Keep this trip after restart");
      const saved = session.read();
      session.dispose();
      await harness.close();
      harness = await startHarness(generator, { sqlitePath });
      session = createUiSession(harness.clientFor(), rendererMetadata);
      await session.open(saved.threadId);
      expect(session.read().ui).toEqual(saved.ui);
      expect(session.read().review?.generationId).toBe(saved.ui!.generationId);
      expect(generations).toBe(1);
      await session.decide(true);
      expect(session.read()).toMatchObject({ approved: true, error: null });
      expect(generations).toBe(1);
      expect(parseSavedUi(session.read().ui).bootstrapMessages).toHaveLength(3);
    } finally {
      session.dispose();
      await harness.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

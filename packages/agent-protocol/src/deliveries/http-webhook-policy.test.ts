import type { Delivery } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";
import { resolveDeps } from "../deps.js";
import { fetchWebhookDispatcher } from "../deps.js";

import { attemptDelivery } from "./attempt-delivery.js";
import { processDelivery } from "./delivery-processor.js";
import { toDeliveryRequest } from "./delivery-request.js";
import { deliveryTargetError } from "./delivery-target.js";
import { configureHttpDelivery } from "./http-delivery-policy.js";

describe("configured HTTP webhook policy", () => {
  it("applies headers, signing and destination restrictions to a custom store without an outbox", async () => {
    const dispatch = vi.fn(async (..._arguments: unknown[]) => undefined);
    const deps = createFixtureDeps({
      webhookDispatcher: dispatch,
      webhooks: {
        headers: { authorization: "credential" },
        secrets: ["signing-key"],
        url: { allowedDomains: ["receiver.example"] },
      },
    });
    deps.store.runs.finalizeWithDelivery = undefined;
    const runtime = createProtocolRuntime(deps);
    await runtime.service.assistants.registerGraphAssistants();
    await runtime.service.runs.createWait({
      assistant_id: "echo",
      input: { value: "one" },
      webhook: "https://receiver.example/path",
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      headers: { authorization: "credential", "x-skein-signature": expect.stringMatching(/^t=/) },
      body: expect.stringContaining('"value":"echo: one"'),
    });
    await runtime.service.runs.createWait({
      assistant_id: "echo",
      input: { value: "two" },
      webhook: "https://blocked.example/path",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects disabled admission and replay before any callback or replay mutation", async () => {
    const deps = createFixtureDeps({ webhooks: { disabled: true } });
    const runtime = createProtocolRuntime(deps);
    await runtime.service.assistants.registerGraphAssistants();
    await expect(
      runtime.service.runs.createWait({
        assistant_id: "echo",
        webhook: "https://receiver.example/path",
      }),
    ).rejects.toMatchObject({ status: 422 });
    const thread = await deps.store.threads.create();
    const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
    const { delivery } = await deps.store.runs.finalizeWithDelivery!(run.run_id, {
      status: "success",
      delivery: {
        thread_id: thread.thread_id,
        url: "https://receiver.example/path",
        payload: { values: {} },
        next_attempt_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const replay = vi.spyOn(deps.store.deliveries!, "retryNow");
    await expect(
      runtime.service.runs.replayDelivery(run.run_id, delivery!.delivery_id),
    ).rejects.toMatchObject({ status: 422 });
    expect(replay).not.toHaveBeenCalled();
  });
  it("keeps signed bytes and server headers authoritative and refuses redirect handling under URL policy", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: unknown) => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const dispatcher = fetchWebhookDispatcher;
    const { attempt, payload } = toDeliveryRequest({
      delivery: {
        delivery_id: "delivery",
        status: "pending",
        payload: { values: { result: "ok" } },
      } as Delivery,
      attempt: 2,
      sentAt: new Date("2026-11-09T00:00:00Z"),
      secrets: ["signing-key"],
    });
    const configured = configureHttpDelivery(attempt, "https://receiver.example", {
      headers: {
        Authorization: "credential",
        "X-Skein-Signature": "forged",
        "Content-Type": "text/plain",
      },
      url: { allowedDomains: ["receiver.example"] },
    });
    try {
      await dispatcher("https://receiver.example", payload, configured);
      expect(fetcher).toHaveBeenCalledWith(
        "https://receiver.example",
        expect.objectContaining({
          body: attempt.body,
          redirect: "error",
          headers: expect.objectContaining({
            authorization: "credential",
            "content-type": "application/json",
            "x-skein-signature": attempt.headers["x-skein-signature"],
          }),
        }),
      );
      await dispatcher("https://receiver.example", payload, attempt);
      expect(fetcher.mock.calls.at(-1)?.[1]).not.toHaveProperty("redirect");
      await dispatcher(
        "https://receiver.example",
        payload,
        configureHttpDelivery(attempt, "https://receiver.example", {
          url: { disableLoopback: false },
        }),
      );
      expect(fetcher.mock.calls.at(-1)?.[1]).not.toHaveProperty("redirect");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("intersects domain restrictions with legacy exact hosts, including deny-all lists and effective ports", async () => {
    expect(
      await deliveryTargetError("https://a.example/path", {
        allowedHosts: ["a.example"],
        url: { allowedDomains: ["b.example"] },
      }),
    ).toContain("allowed_domains");
    expect(
      await deliveryTargetError("https://child.example/path", {
        url: { allowedDomains: ["*.example"], allowedPorts: [443] },
      }),
    ).toBeUndefined();
    expect(
      await deliveryTargetError("https://example/path", { url: { allowedDomains: ["*.example"] } }),
    ).toContain("allowed_domains");
    expect(
      await deliveryTargetError("https://a.example/path", { url: { allowedDomains: [] } }),
    ).toContain("allowed_domains");
    expect(
      await deliveryTargetError("https://a.example/path", { url: { allowedPorts: [] } }),
    ).toContain("allowed_ports");
    expect(
      await deliveryTargetError("http://a.example/path", { url: { allowedPorts: [443] } }),
    ).toContain("allowed_ports");
  });

  it.each(["127.0.0.1", "127.1", "2130706433", "[::1]", "[::ffff:127.0.0.1]", "localhost"])(
    "refuses a loopback destination before dispatch: %s",
    async (host) => {
      expect(
        await deliveryTargetError(`http://${host}/secret`, { url: { disableLoopback: true } }),
      ).toContain("loopback");
    },
  );

  it.each(["inline", "queued"])(
    "keeps disabled HTTP payloads as visible dead letters through the %s path without suppressing host outcomes",
    async (path) => {
      const dispatch = vi.fn(async () => undefined);
      const resolved = resolveDeps(
        createFixtureDeps({
          webhooks: { disabled: true, headers: { authorization: "private-value" } },
          webhookDispatcher: dispatch,
        }),
      );
      const assistant = await resolved.store.assistants.create({ graph_id: "echo" });
      const thread = await resolved.store.threads.create();
      const run = await resolved.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: assistant.assistant_id,
      });
      const deliver = async (url: string) => {
        const { delivery } = await resolved.store.runs.finalizeWithDelivery!(run.run_id, {
          status: "success",
          delivery: {
            thread_id: thread.thread_id,
            url,
            payload: { values: {} },
            payload_truncated: false,
            next_attempt_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        if (path === "inline") await attemptDelivery(resolved, delivery as Delivery);
        else
          await processDelivery(resolved, {
            deliveryId: delivery!.delivery_id,
            isFinalAttempt: false,
          });
        return resolved.store.deliveries!.get(delivery!.delivery_id);
      };
      const blocked = await deliver("https://receiver.example/path");
      expect(blocked?.status).toBe("dead");
      expect(blocked?.last_error).toContain("disabled");
      expect(dispatch).not.toHaveBeenCalled();
      for (const target of ["skein+channel://configured", "skein-bullmq://configured"]) {
        expect((await deliver(target))?.status).toBe("delivered");
      }
      for (const call of dispatch.mock.calls) expect(call).not.toContain("private-value");
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain("private-value");
    },
  );
});

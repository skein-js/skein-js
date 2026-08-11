// One delivery attempt, and what it records. This is the only place that decides when a failure is
// terminal, so both the engine's inline attempt and the worker's retries agree by construction.

import type { Delivery, DeliveryAttemptResult, DeliveryRepo } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import type { Logger, WebhookDispatcher } from "../deps.js";

import { attemptDelivery, type AttemptDeliveryDeps } from "./attempt-delivery.js";
import type { WebhookDeliveryConfig } from "./delivery-config.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

/** Collects what was logged, so the "never rejects" cases can prove they reported rather than hid. */
function collectingLogger() {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
  };
  return { logger, errors };
}

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    delivery_id: "d-1",
    run_id: "run-1",
    thread_id: "thread-1",
    url: "https://hooks.example.test/skein",
    payload: { run_id: "run-1", values: { answer: 42 } },
    payload_truncated: false,
    run_status: "success",
    status: "delivering",
    attempt: 1,
    next_attempt_at: NOW.toISOString(),
    last_error: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
    ...overrides,
  };
}

/** A `DeliveryRepo` that only records — the rest of the surface is not on this path. */
function recordingRepo() {
  const recorded: DeliveryAttemptResult[] = [];
  const repo = {
    recordAttempt: vi.fn(async (_id: string, result: DeliveryAttemptResult) => {
      recorded.push(result);
      return delivery({ status: result.outcome === "delivered" ? "delivered" : "pending" });
    }),
  } as unknown as DeliveryRepo;
  return { repo, recorded };
}

function depsFor(
  dispatch: WebhookDispatcher,
  repo: DeliveryRepo,
  webhooks?: WebhookDeliveryConfig,
  logger: Logger = collectingLogger().logger,
): AttemptDeliveryDeps {
  return {
    store: { deliveries: repo },
    webhookDispatcher: dispatch,
    logger,
    clock: () => NOW,
    ...(webhooks ? { webhooks } : {}),
  };
}

describe("attemptDelivery", () => {
  it("sends the stored body with the run's committed status merged in", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(depsFor(dispatch, repo), delivery({ run_status: "cancelled" }));

    const [url, body, attempt] = dispatch.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.test/skein");
    expect(body).toMatchObject({ run_id: "run-1", status: "cancelled" });
    expect(recorded).toEqual([{ outcome: "delivered" }]);
    // The dedup key the receiver needs to make at-least-once safe on their side. Shipped with the
    // retries rather than after them: retrying without it turns our reliability improvement into
    // their duplicate-processing bug.
    expect(attempt?.headers).toMatchObject({
      "x-skein-delivery-id": "d-1",
      "x-skein-attempt": "1",
    });
  });

  it("keeps the delivery id stable across attempts, and moves the attempt number", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { repo } = recordingRepo();

    await attemptDelivery(depsFor(dispatch, repo), delivery({ attempt: 1 }));
    await attemptDelivery(depsFor(dispatch, repo), delivery({ attempt: 4 }));

    const [first, second] = dispatch.mock.calls;
    expect(first?.[2]?.headers["x-skein-delivery-id"]).toBe("d-1");
    // Same id — that is what makes it a dedup key rather than a request id.
    expect(second?.[2]?.headers["x-skein-delivery-id"]).toBe("d-1");
    expect(first?.[2]?.headers["x-skein-attempt"]).toBe("1");
    expect(second?.[2]?.headers["x-skein-attempt"]).toBe("4");
  });

  it("schedules the next attempt when one is left", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("503 from receiver"));
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(depsFor(dispatch, repo), delivery({ attempt: 3 }));

    expect(recorded[0]).toMatchObject({ outcome: "retrying", error: "503 from receiver" });
    // Due in the future, off the injected clock rather than the driver's.
    const next = (recorded[0] as { nextAttemptAt: string }).nextAttemptAt;
    expect(new Date(next).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("declares a delivery dead once its last attempt fails", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("still down"));
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(
      depsFor(dispatch, repo, { retries: { maxAttempts: 3 } }),
      delivery({ attempt: 3 }),
    );

    expect(recorded).toEqual([{ outcome: "dead", error: "still down" }]);
  });

  it("treats max_attempts: 1 as the pre-outbox fire-once behaviour", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("nope"));
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(
      depsFor(dispatch, repo, { retries: { maxAttempts: 1 } }),
      delivery({ attempt: 1 }),
    );

    expect(recorded[0]?.outcome).toBe("dead");
  });

  // Both callers depend on this: the engine's `finally` must not turn a failed callback into a failed
  // run, and the worker's tick must not lose the rest of its batch to one bad receiver.
  it("never rejects, even when recording the outcome is the thing that fails", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const repo = {
      recordAttempt: vi.fn().mockRejectedValue(new Error("database gone")),
    } as unknown as DeliveryRepo;
    const { logger, errors } = collectingLogger();

    // Resolves rather than throws, and says so in the log. The row keeps its lease, so the next
    // claim retries it — one duplicate POST, which at-least-once already permits.
    expect(
      await attemptDelivery(depsFor(dispatch, repo, undefined, logger), delivery()),
    ).toBeNull();
    expect(errors.join("\n")).toContain("could not record");
  });

  // The bug this guards: wrapping the POST and the record in one `try` reads a database blip *after*
  // a successful POST as a failed delivery, schedules a retry, and so POSTs a second time to a
  // receiver that already has it.
  it("does not schedule a retry when the POST succeeded and only the record failed", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const recordAttempt = vi.fn().mockRejectedValue(new Error("database gone"));
    const repo = { recordAttempt } as unknown as DeliveryRepo;

    await attemptDelivery(depsFor(dispatch, repo), delivery());

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(recordAttempt.mock.calls[0]![1]).toEqual({ outcome: "delivered" });
  });

  // Regression: this branch used to return the store write unguarded, so a store failure rejected a
  // function documented never to reject — and the engine awaits it inside a `finally`, so the
  // rejection escaped and skipped the cleanup after it (a leaked control-registry entry, an undeleted
  // stateless thread, and a 500 on a run that actually succeeded).
  it("does not reject when the store fails while refusing a disallowed host", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const repo = {
      recordAttempt: vi.fn().mockRejectedValue(new Error("database gone")),
    } as unknown as DeliveryRepo;
    const { logger, errors } = collectingLogger();

    expect(
      await attemptDelivery(
        depsFor(dispatch, repo, { allowedHosts: ["hooks.allowed.test"] }, logger),
        delivery({ url: "https://elsewhere.test/hook" }),
      ),
    ).toBeNull();
    expect(errors.join("\n")).toContain("could not record");
  });

  // Regression: the row is written first, with `next_attempt_at` hours out because a queue was
  // supposed to own the schedule. When the hand-off fails, nothing does — so a momentary Redis blip
  // turned a one-second retry into a multi-hour one.
  it("falls back to the polling schedule when the queue will not take the retry", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("503"));
    const { repo, recorded } = recordingRepo();
    const { logger, errors } = collectingLogger();
    const deliveryQueue = {
      schedule: vi.fn().mockRejectedValue(new Error("redis is down")),
      consume: () => ({ close: async () => {} }),
      durable: true,
    };

    await attemptDelivery(
      { ...depsFor(dispatch, repo, { retries: { maxAttempts: 12 } }, logger), deliveryQueue },
      delivery({ attempt: 1 }),
    );

    expect(errors.join("\n")).toContain("could not hand the retry");
    // Rewritten to the ordinary backoff — seconds — rather than left at the sweep's hours-long grace.
    const rewritten = recorded.at(-1) as { nextAttemptAt: string };
    expect(new Date(rewritten.nextAttemptAt).getTime() - NOW.getTime()).toBeLessThan(60_000);
  });

  it("hands the retry to the queue with the attempts it has left", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("503"));
    const { repo } = recordingRepo();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const deliveryQueue = { schedule, consume: () => ({ close: async () => {} }), durable: true };

    await attemptDelivery(
      { ...depsFor(dispatch, repo, { retries: { maxAttempts: 12 } }), deliveryQueue },
      delivery({ attempt: 1 }),
    );

    expect(schedule.mock.calls[0]![1]).toMatchObject({ attempts: 11 });
  });

  it("kills a delivery to a host outside the allowlist without trying it", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(
      depsFor(dispatch, repo, { allowedHosts: ["hooks.allowed.test"] }),
      delivery({ url: "https://169.254.169.254/latest/meta-data" }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    // Dead rather than retried: no number of attempts makes a disallowed host allowed. Recorded
    // rather than skipped, so it shows up as a failed delivery instead of a callback that vanished.
    expect(recorded[0]).toMatchObject({ outcome: "dead" });
    expect((recorded[0] as { error: string }).error).toContain("allowed_hosts");
  });

  it("matches an allowlisted host exactly, not by suffix", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { repo, recorded } = recordingRepo();

    // The classic way an allowlist stops being one: "example.test" also admitting "notexample.test".
    await attemptDelivery(
      depsFor(dispatch, repo, { allowedHosts: ["example.test"] }),
      delivery({ url: "https://notexample.test/hook" }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(recorded[0]?.outcome).toBe("dead");
  });

  it("sends to a host that is on the allowlist", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { repo, recorded } = recordingRepo();

    await attemptDelivery(
      depsFor(dispatch, repo, { allowedHosts: ["hooks.example.test"] }),
      delivery(),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([{ outcome: "delivered" }]);
  });

  it("does nothing on a store with no deliveries repo", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const deps = {
      store: {},
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => NOW,
    } as AttemptDeliveryDeps;

    expect(await attemptDelivery(deps, delivery())).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

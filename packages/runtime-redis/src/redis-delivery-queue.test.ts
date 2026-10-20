import { beforeEach, describe, expect, it, vi } from "vitest";

import { RedisDeliveryQueue } from "./redis-delivery-queue.js";

const { queueConnection, workerConnection } = vi.hoisted(() => ({
  queueConnection: { waitUntilReady: vi.fn(), close: vi.fn() },
  workerConnection: { waitUntilReady: vi.fn(), close: vi.fn() },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    waitUntilReady = queueConnection.waitUntilReady;
    close = queueConnection.close;
  },
  Worker: class {
    waitUntilReady = workerConnection.waitUntilReady;
    close = workerConnection.close;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  for (const connection of [queueConnection, workerConnection]) {
    connection.waitUntilReady.mockResolvedValue(undefined);
    connection.close.mockResolvedValue(undefined);
  }
});

describe("RedisDeliveryQueue teardown", () => {
  it("finishes an unused queue's handshake before closing its connection", async () => {
    const queue = new RedisDeliveryQueue("redis://unused");
    let finishHandshake!: () => void;
    queueConnection.waitUntilReady.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHandshake = resolve;
      }),
    );

    const disposing = queue.dispose();
    try {
      expect(queueConnection.waitUntilReady).toHaveBeenCalledOnce();
      expect(queueConnection.close).not.toHaveBeenCalled();
    } finally {
      finishHandshake();
      await disposing;
    }
    expect(queueConnection.close).toHaveBeenCalledOnce();
  });

  it("finishes a consumer's handshake before gracefully closing it", async () => {
    const queue = new RedisDeliveryQueue("redis://unused");
    const consumer = queue.consume(async () => {});
    let finishHandshake!: () => void;
    workerConnection.waitUntilReady.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHandshake = resolve;
      }),
    );

    const closing = consumer.close();
    try {
      expect(workerConnection.waitUntilReady).toHaveBeenCalledOnce();
      expect(workerConnection.close).not.toHaveBeenCalled();
    } finally {
      finishHandshake();
      await closing;
      await queue.dispose();
    }
    expect(workerConnection.close).toHaveBeenCalledWith(false);
  });

  it("closes a forced consumer without waiting for its handshake", async () => {
    const queue = new RedisDeliveryQueue("redis://unused");
    const consumer = queue.consume(async () => {});
    try {
      await consumer.close(true);
      expect(workerConnection.waitUntilReady).not.toHaveBeenCalled();
      expect(workerConnection.close).toHaveBeenCalledWith(true);
    } finally {
      await queue.dispose();
    }
  });
});

import { expect, it } from "vitest";

import { createEchoDeps, startEchoServer } from "./__fixtures__/echo-server.js";

it("completes terminal stream joins with replay and a lost bus marker (app)", async () => {
  const deps = createEchoDeps();
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "error",
  });
  await deps.bus.publish(run.run_id, { seq: 1, event: "values", data: { retained: true } });
  const server = await startEchoServer({ deps, router: "app" });
  try {
    const response = await fetch(
      `${server.baseUrl}/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      { signal: AbortSignal.timeout(2000) },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"retained":true');
  } finally {
    await server.close();
  }
});
it("completes terminal stream joins with replay and a lost bus marker (pages)", async () => {
  const deps = createEchoDeps();
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "error",
  });
  await deps.bus.publish(run.run_id, { seq: 1, event: "values", data: { retained: true } });
  const server = await startEchoServer({ deps, router: "pages" });
  try {
    const response = await fetch(
      `${server.baseUrl}/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
      { signal: AbortSignal.timeout(2000) },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"retained":true');
  } finally {
    await server.close();
  }
});

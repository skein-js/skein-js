import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import type { ProtocolRequest } from "../create-handlers.js";
import { createProtocolRuntime } from "../runtime.js";

const request = (body: unknown): ProtocolRequest => ({
  method: "POST",
  url: "http://localhost/threads/search",
  params: {},
  query: {},
  headers: {},
  body,
});
it("applies exclusion before paging and projection/extraction after selection", async () => {
  const deps = createFixtureDeps();
  const runtime = createProtocolRuntime(deps);
  await deps.store.threads.create({ metadata: { private: true } });
  const thread = await deps.store.threads.create({ metadata: { title: "readable" } });
  await deps.store.threads.update(thread.thread_id, {
    values: { messages: [{ content: "first" }, { content: "last" }] },
  });
  const response = await runtime.handlers.listThreads(
    request({
      exclude_metadata: { private: true },
      limit: 1,
      select: ["thread_id"],
      extract: { last: "values.messages[-1].content", missing: "metadata.absent" },
    }),
  );
  expect(response).toMatchObject({
    kind: "json",
    body: [{ thread_id: thread.thread_id, last: "last", missing: null }],
  });
  if (response.kind === "json")
    expect(response.body).toEqual([{ thread_id: thread.thread_id, last: "last", missing: null }]);
});

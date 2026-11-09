import { AIMessage } from "@langchain/core/messages";
import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { SkeinHttpError } from "@skein-js/core";
import { createDeepAgent } from "deepagents";
import { expect, it } from "vitest";

import { FixtureModel } from "./fixture-model.mjs";

class TaskModel extends FixtureModel {
  async _generate(messages) {
    const content = messages.findLast((message) => message.getType() === "human").content;
    const [command, taskId] = String(content).split(" ");
    this.steps =
      command === "start"
        ? [{ name: "start_async_task", args: { agentName: "child", description: "hold" } }]
        : command === "update"
          ? [{ name: "update_async_task", args: { taskId, message: "queued follow-up" } }]
          : command === "check"
            ? [{ name: "check_async_task", args: { taskId } }]
            : [];
    return super._generate(messages);
  }
}

const auth = {
  enabled: true,
  studioAuthDisabled: true,
  async authenticate(request) {
    const identity = request.headers.get("x-user");
    if (!identity) throw SkeinHttpError.unauthorized("No caller");
    return {
      user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
      scopes: [],
    };
  },
  async authorize({ resource, context, value }) {
    return {
      value,
      ...(resource === "threads" ? { filters: { owner: context.user.identity } } : {}),
    };
  },
  matchesFilters: (metadata, filters) => metadata?.owner === filters?.owner,
};

async function mount() {
  let url;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  class ChildModel extends FixtureModel {
    async _generate(messages, _options, _runManager) {
      calls.push(messages);
      await blocked;
      const message = new AIMessage({
        content: [
          { type: "text", text: "Child completed" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      });
      return { generations: [{ message, text: "Child completed" }] };
    }
  }
  const child = createDeepAgent({ model: new ChildModel() });
  const agent = (config) =>
    createDeepAgent({
      model: new TaskModel(),
      subagents: [
        {
          name: "child",
          description: "Background research",
          graphId: "child",
          url,
          mode: "fork",
          updateStrategy: "enqueue",
          headers: { "x-user": config.configurable?.langgraph_auth_user_id ?? "" },
        },
      ],
    });
  const deps = embedInMemoryGraphs({ agent, child });
  const server = await createExpressServer({ deps: { ...deps, auth } });
  const listener = await server.listen(0, "127.0.0.1");
  url = `http://127.0.0.1:${listener.address().port}`;
  const client = (user) => new Client({ apiUrl: url, defaultHeaders: { "x-user": user } });
  return { url, client, calls, release, close: () => server.close(), deps };
}

it("keeps two runtimes and concurrent callers isolated for explicit-URL forks, queued updates and media", async () => {
  const mounts = await Promise.all([mount(), mount()]);
  try {
    for (const mounted of mounts) {
      const callers = ["alice", "bob"].map((user) => ({ user, client: mounted.client(user) }));
      const tasks = await Promise.all(
        callers.map(async ({ client, user }) => {
          const parent = await client.threads.create();
          await client.runs.wait(parent.thread_id, "agent", {
            input: { messages: [{ role: "user", content: `PRIVATE_FORK_CONTEXT_${user}` }] },
          });
          const started = await client.runs.wait(parent.thread_id, "agent", {
            input: { messages: [{ role: "user", content: "start" }] },
          });
          const task = Object.values(started.asyncTasks ?? {})[0];
          expect(task, JSON.stringify(started)).toBeDefined();
          return { client, user, parent, task };
        }),
      );
      await expect(tasks[0].client.threads.get(tasks[1].task.threadId)).rejects.toThrow();
      await expect(
        mounts
          .find((entry) => entry !== mounted)
          .client("alice")
          .threads.get(tasks[0].task.threadId),
      ).rejects.toThrow();
      await expect.poll(() => mounted.calls.length).toBeGreaterThanOrEqual(2);
      for (const { client, user, parent, task } of tasks) {
        const childRuns = await client.runs.list(task.threadId);
        expect(childRuns[0].status).toBe("running");
        const queued = await client.runs.wait(parent.thread_id, "agent", {
          input: { messages: [{ role: "user", content: `update ${task.taskId}` }] },
        });
        const update = queued.asyncTasks[task.taskId];
        expect(update.status).toBe("pending");
        expect(update.supersededRunIds).toContain(task.runId);
        const inherited = mounted.calls.find((messages) =>
          JSON.stringify(messages).includes(`PRIVATE_FORK_CONTEXT_${user}`),
        );
        expect(inherited).toBeDefined();
        expect(JSON.stringify(inherited)).not.toContain(
          `PRIVATE_FORK_CONTEXT_${user === "alice" ? "bob" : "alice"}`,
        );
      }
      mounted.release();
      for (const { client, parent, task } of tasks) {
        await expect
          .poll(async () =>
            (await client.runs.list(task.threadId)).every((run) => run.status === "success"),
          )
          .toBe(true);
        const checked = await client.runs.wait(parent.thread_id, "agent", {
          input: { messages: [{ role: "user", content: `check ${task.taskId}` }] },
        });
        expect(checked.asyncTasks[task.taskId].status).toBe("success");
        const notification = checked.messages.findLast(
          (message) => message.additional_kwargs?.lc_source === "async_subagent",
        );
        expect(notification.additional_kwargs.lc_data).toMatchObject({
          task_id: task.taskId,
          status: "success",
        });
        expect(notification.content).toContainEqual({
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        });
      }
    }
  } finally {
    for (const mounted of mounts) {
      mounted.release();
      await mounted.close();
    }
  }
});

it("delivers an application-owned parent notification through authorized atomic admission", async () => {
  const mounted = await mount();
  const client = mounted.client("alice");
  const post = (threadId, user, key) =>
    fetch(`${mounted.url}/threads/${threadId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": user, "idempotency-key": key },
      body: JSON.stringify({
        assistant_id: "agent",
        input: { messages: [{ role: "user", content: "Child completed" }] },
        if_thread_status: ["idle", "error"],
        multitask_strategy: "reject",
      }),
    });
  try {
    const parent = await client.threads.create();
    const denied = await post(parent.thread_id, "bob", "child-completion");
    expect([403, 404]).toContain(denied.status);
    const accepted = await post(parent.thread_id, "alice", "child-completion");
    expect(accepted.status).toBe(200);
    const admitted = await accepted.json();
    await client.runs.join(parent.thread_id, admitted.run_id);
    expect(
      JSON.stringify((await client.threads.getState(parent.thread_id)).values.messages),
    ).toContain("Child completed");
    expect(
      (await post(parent.thread_id, "alice", "child-completion")).headers.get("idempotent-replay"),
    ).toBe("true");
    // A waiting/busy parent cannot be displaced by a completion, even between read and admission.
    await mounted.deps.store.threads.update(parent.thread_id, { status: "interrupted" });
    expect((await post(parent.thread_id, "alice", "another-child")).status).toBe(409);
    await mounted.deps.store.threads.update(parent.thread_id, { status: "busy" });
    expect((await post(parent.thread_id, "alice", "another-child")).status).toBe(409);
    expect(
      (await client.runs.list(parent.thread_id)).filter((run) => run.status === "success"),
    ).toHaveLength(1);
  } finally {
    mounted.release();
    await mounted.close();
  }
});

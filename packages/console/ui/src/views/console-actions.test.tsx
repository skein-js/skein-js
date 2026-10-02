import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  assistants: {
    get: vi.fn(),
    getGraph: vi.fn(),
    getSchemas: vi.fn(),
    getVersions: vi.fn(),
    update: vi.fn(),
  },
  crons: {
    search: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  store: {
    listNamespaces: vi.fn(),
    searchItems: vi.fn(),
    putItem: vi.fn(),
    deleteItem: vi.fn(),
  },
  threads: {
    getHistory: vi.fn(),
  },
}));
const deliveryClient = vi.hoisted(() => ({
  listRunDeliveries: vi.fn(),
  replayRunDelivery: vi.fn(),
}));

vi.mock("@/api", () => ({
  createConsoleClient: () => client,
  createSkeinConsoleClient: () => deliveryClient,
}));

import { AssistantsView } from "./assistants";
import { CheckpointHistory } from "./checkpoints";
import { CronsView } from "./crons";
import { RunDeliveries } from "./run-deliveries";
import { StoreView } from "./store";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  client.crons.search.mockResolvedValue([
    { cron_id: "cron-1", assistant_id: "assistant-1", schedule: "*/5 * * * *", enabled: true },
  ]);
  client.crons.count.mockResolvedValue(1);
  client.crons.delete.mockResolvedValue(undefined);
  client.store.listNamespaces.mockResolvedValue({ namespaces: [["notes"]] });
  client.store.searchItems.mockResolvedValue({
    items: [{ namespace: ["notes"], key: "k", value: { text: "old" }, updatedAt: "2026-01-01" }],
  });
  client.store.putItem.mockResolvedValue(undefined);
  client.assistants.get.mockResolvedValue({
    assistant_id: "assistant-1",
    graph_id: "echo",
    name: "Echo",
    description: "Original",
    version: 1,
    metadata: {},
    config: {},
  });
  client.assistants.getGraph.mockResolvedValue({});
  client.assistants.getSchemas.mockResolvedValue({});
  client.assistants.getVersions.mockResolvedValue([]);
  client.assistants.update.mockResolvedValue(undefined);
  deliveryClient.listRunDeliveries.mockResolvedValue({
    deliveries: [
      {
        delivery_id: "delivery-1",
        status: "dead",
        replayable: true,
        url: "https://hooks.example/callback",
        attempt: 3,
        updated_at: "2026-01-01",
      },
    ],
  });
  deliveryClient.replayRunDelivery.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("console mutations", () => {
  it("does not delete a schedule when confirmation is cancelled", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    render(<CronsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(client.crons.delete).not.toHaveBeenCalled();
  });

  it("validates store edits, shows server errors, and reloads after a successful save", async () => {
    client.store.putItem.mockRejectedValueOnce(new Error("write denied"));
    render(<StoreView />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit k" }));
    const editor = screen.getByRole("textbox", { name: "Value (JSON)" });

    fireEvent.change(editor, { target: { value: "[1]" } });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    expect((await screen.findByRole("alert")).textContent).toContain("JSON object");
    expect(client.store.putItem).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: '{"text":"new"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    expect((await screen.findByRole("alert")).textContent).toContain("write denied");

    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() =>
      expect(client.store.putItem).toHaveBeenCalledWith(["notes"], "k", { text: "new" }),
    );
    await waitFor(() => expect(client.store.searchItems).toHaveBeenCalledTimes(2));
  });

  it("does not rewrite a store item when the expiry reset is declined", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    render(<StoreView />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit k" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Value (JSON)" }), {
      target: { value: '{"text":"new"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("expiry")));
    expect(client.store.putItem).not.toHaveBeenCalled();
  });

  it("sends only changed assistant fields and keeps an unsuccessful edit visible", async () => {
    client.assistants.update.mockRejectedValueOnce(new Error("update denied"));
    render(<AssistantsView assistantId="assistant-1" />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save assistant" }));
    expect((await screen.findByRole("alert")).textContent).toContain("update denied");
    expect((name as HTMLInputElement).value).toBe("Renamed");

    fireEvent.click(screen.getByRole("button", { name: "Save assistant" }));
    await waitFor(() =>
      expect(client.assistants.update).toHaveBeenLastCalledWith("assistant-1", { name: "Renamed" }),
    );
    await waitFor(() => expect(client.assistants.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.assistants.getGraph).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.assistants.getSchemas).toHaveBeenCalledTimes(2));
  });

  it("rejects removal of assistant metadata keys that PATCH would retain", async () => {
    client.assistants.get.mockResolvedValueOnce({
      assistant_id: "assistant-1",
      graph_id: "echo",
      name: "Echo",
      version: 1,
      metadata: { owner: "team" },
      config: {},
    });
    render(<AssistantsView assistantId="assistant-1" />);
    const metadata = await screen.findByRole("textbox", { name: "Metadata (JSON)" });
    fireEvent.change(metadata, { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save assistant" }));
    expect((await screen.findByRole("alert")).textContent).toContain("removing owner");
    expect(client.assistants.update).not.toHaveBeenCalled();
  });

  it("uses the last visible checkpoint as the next history cursor", async () => {
    const history = Array.from({ length: 22 }, (_, index) => ({
      checkpoint: { checkpoint_id: `checkpoint-${index}` },
      created_at: "2026-01-01",
      next: [],
    }));
    client.threads.getHistory.mockImplementation(async (_threadId, options) => {
      const before = options.before?.configurable?.checkpoint_id;
      const start = before
        ? history.findIndex((row) => row.checkpoint.checkpoint_id === before) + 1
        : 0;
      return history.slice(start, start + options.limit);
    });
    render(<CheckpointHistory threadId="thread-1" assistantId={undefined} onForked={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(client.threads.getHistory).toHaveBeenLastCalledWith("thread-1", {
        limit: 21,
        before: { configurable: { checkpoint_id: "checkpoint-19" } },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("lists a failed delivery and replays it only after confirmation", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<RunDeliveries threadId="thread-1" runId="run-1" />);
    const replay = await screen.findByRole("button", { name: "Replay" });
    fireEvent.click(replay);
    expect(deliveryClient.replayRunDelivery).not.toHaveBeenCalled();

    fireEvent.click(replay);
    await waitFor(() =>
      expect(deliveryClient.replayRunDelivery).toHaveBeenCalledWith(
        "thread-1",
        "run-1",
        "delivery-1",
      ),
    );
    await waitFor(() => expect(deliveryClient.listRunDeliveries).toHaveBeenCalledTimes(2));
  });
});

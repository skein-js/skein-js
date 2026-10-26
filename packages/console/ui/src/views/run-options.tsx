import type { StreamMode } from "@langchain/langgraph-sdk";

export interface RunOptions {
  target: "thread" | "stateless" | "batch";
  threadId: string;
  delay: string;
  timeout: string;
  idempotencyKey: string;
  multitask: "reject" | "interrupt" | "rollback" | "enqueue";
  completion: "keep" | "delete";
  capture: StreamMode[];
}
export const DEFAULT_RUN_OPTIONS: RunOptions = {
  target: "thread",
  threadId: "",
  delay: "",
  timeout: "",
  idempotencyKey: "",
  multitask: "reject",
  completion: "keep",
  capture: ["values", "messages-tuple", "updates"],
};

export function parseRunOptions(options: RunOptions) {
  const afterSeconds = options.delay === "" ? 0 : Number(options.delay);
  const timeoutMs = options.timeout === "" ? undefined : Number(options.timeout);
  if (!Number.isInteger(afterSeconds) || afterSeconds < 0 || afterSeconds > 86400)
    throw new Error("Delay must be a whole number of seconds from 0 to 86400.");
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
  )
    throw new Error("Execution timeout must be whole milliseconds from 1 to 2147483647.");
  if (options.idempotencyKey && !/^[\x20-\x7e]{1,255}$/.test(options.idempotencyKey))
    throw new Error("Idempotency key must contain 1–255 printable ASCII characters.");
  if (!options.capture.length) throw new Error("Select at least one stream capture mode.");
  return { afterSeconds, timeoutMs, idempotencyKey: options.idempotencyKey || undefined };
}

export function RunOptionsForm({
  value,
  onChange,
  timeoutSupported,
  disabled,
  jsonMode,
}: {
  value: RunOptions;
  onChange: (value: RunOptions) => void;
  timeoutSupported: boolean;
  disabled: boolean;
  jsonMode: boolean;
}) {
  const set = <K extends keyof RunOptions>(key: K, next: RunOptions[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <details className="mb-3 rounded-lg border bg-muted/30 p-3">
      <summary className="cursor-pointer text-xs font-medium">Advanced run options</summary>
      <fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="field-label">
          Run scope
          <select
            aria-label="Run scope"
            className="field"
            value={value.target}
            onChange={(event) => set("target", event.target.value as RunOptions["target"])}
          >
            <option value="thread">Thread · keep state across turns</option>
            <option value="stateless">Stateless · fresh server-created thread</option>
            <option value="batch" disabled={!jsonMode}>
              Batch · JSON array of 1–100 inputs
            </option>
          </select>
        </label>
        {value.target === "thread" && (
          <label className="field-label">
            Existing thread ID (optional)
            <input
              aria-label="Existing thread ID (optional)"
              className="field"
              value={value.threadId}
              onChange={(event) => set("threadId", event.target.value)}
              placeholder="Blank uses this session"
            />
            <span className="help">An existing thread must already exist on the server.</span>
          </label>
        )}
        <label className="field-label">
          Start after (seconds)
          <input
            aria-label="Start after (seconds)"
            className="field"
            type="number"
            min="0"
            max="86400"
            value={value.delay}
            onChange={(event) => set("delay", event.target.value)}
            placeholder="0"
          />
          <span className="help">
            Delayed runs execute in the background. Leaving this view keeps them queued.
          </span>
        </label>
        <label className="field-label">
          Execution timeout (milliseconds)
          <input
            aria-label="Execution timeout (milliseconds)"
            className="field"
            type="number"
            min="1"
            max="2147483647"
            disabled={!timeoutSupported}
            value={value.timeout}
            onChange={(event) => set("timeout", event.target.value)}
            placeholder="Server default"
          />
          <span className="help">
            {timeoutSupported
              ? "Starts when execution begins. The server's limit still applies."
              : "This server has not confirmed per-run timeout support."}
          </span>
        </label>
        <label className="field-label">
          If the thread is busy
          <select
            aria-label="If the thread is busy"
            className="field"
            value={value.multitask}
            onChange={(event) => set("multitask", event.target.value as RunOptions["multitask"])}
          >
            <option value="reject">Reject the new run</option>
            <option value="enqueue">Queue the new run</option>
            <option value="interrupt">Interrupt the current run, keeping writes</option>
            <option value="rollback">Roll back the current run and its writes</option>
          </select>
        </label>
        <label className="field-label">
          Idempotency key (optional)
          <input
            aria-label="Idempotency key (optional)"
            className="field"
            value={value.idempotencyKey}
            onChange={(event) => set("idempotencyKey", event.target.value)}
          />
          <span className="help">
            Reusing the key with the same request avoids creating another run. Keyed runs are
            created in the background, then observed.
          </span>
        </label>
        {value.target !== "thread" && (
          <label className="field-label">
            After completion
            <select
              aria-label="After completion"
              className="field"
              value={value.completion}
              onChange={(event) => set("completion", event.target.value as "keep" | "delete")}
            >
              <option value="keep">Keep thread and history</option>
              <option value="delete">Delete generated thread and history</option>
            </select>
            <span className="help">Deleted results cannot be inspected afterward.</span>
          </label>
        )}
        <div className="field-label sm:col-span-2">
          Capture reported events
          <div className="flex flex-wrap gap-3">
            {(
              ["values", "messages-tuple", "updates", "custom", "events", "debug"] as StreamMode[]
            ).map((capture) => (
              <label key={capture} className="flex items-center gap-2 text-xs font-normal">
                <input
                  type="checkbox"
                  checked={value.capture.includes(capture)}
                  onChange={(event) =>
                    set(
                      "capture",
                      event.target.checked
                        ? [...value.capture, capture]
                        : value.capture.filter((mode) => mode !== capture),
                    )
                  }
                />
                {capture}
              </label>
            ))}
          </div>
          <span className="help">
            Chat uses messages and values; other modes remain available in raw events. Batch creates
            independent runs and may partially succeed before an error.
          </span>
        </div>
      </fieldset>
    </details>
  );
}

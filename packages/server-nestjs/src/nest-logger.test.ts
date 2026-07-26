// Nest reads a log call's trailing arguments *positionally* — the last string is the context, and for
// `error` the one before it is the stack. Getting that wrong doesn't crash; it quietly relabels the
// context as a message or swallows a stack, which is exactly the kind of bug nobody notices until
// they need the log. These tests pin the argument shape, not just that something was logged.

import { ConsoleLogger, Logger as NestLoggerClass, type LoggerService } from "@nestjs/common";
import { RUN_FAILURE_REPORT_KIND, type RunFailureReport } from "@skein-js/agent-protocol";
import { describe, expect, it, vi } from "vitest";

import { createNestLogger } from "./nest-logger.js";

/** A `LoggerService` recording the exact argument list each level received. */
function capturingLoggerService(): LoggerService & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push({ level, args });
    };
  return {
    calls,
    log: record("log"),
    error: record("error"),
    warn: record("warn"),
    debug: record("debug"),
  };
}

function failureReport(): RunFailureReport {
  return {
    kind: RUN_FAILURE_REPORT_KIND,
    runId: "run-1",
    threadId: "thread-1",
    assistantId: "assistant-1",
    failingNodes: ["research"],
    error: new Error("graph exploded"),
    wireError: { error: "Error", message: "graph exploded", name: "Error" },
  };
}

describe("createNestLogger", () => {
  it("maps skein levels onto Nest's, with info becoming log", () => {
    const target = capturingLoggerService();
    const logger = createNestLogger({ logger: target });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(target.calls.map((call) => call.level)).toEqual(["debug", "log", "warn", "error"]);
  });

  it("passes the context as the final argument on every level", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target, context: "Graphs" }).warn("careful");
    expect(target.calls[0]?.args).toEqual(["careful", "Graphs"]);
  });

  it("defaults the context to Skein", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target }).info("hello");
    expect(target.calls[0]?.args).toEqual(["hello", "Skein"]);
  });

  it("puts a failed run's stack in Nest's stack slot, with the identity on the message", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target }).error("Graph run failed", failureReport());

    const [message, stack, context] = target.calls[0]?.args as [string, string, string];
    expect(message).toContain("Graph run failed");
    expect(message).toContain("run=run-1");
    expect(message).toContain("node=research");
    // The stack belongs in its own slot — not appended to the message, where Nest would print it as
    // an undifferentiated blob rather than a trace.
    expect(stack).toContain("Error: graph exploded");
    expect(stack).toContain("    at ");
    expect(context).toBe("Skein");
  });

  it("unwraps a bare Error into the stack slot too", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target }).error("webhook failed", new Error("connection refused"));

    const [message, stack] = target.calls[0]?.args as [string, string];
    expect(message).toBe("webhook failed");
    expect(stack).toContain("connection refused");
  });

  it("keeps the stack slot explicit when there is no error, so context stays context", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target }).error("plain failure");
    expect(target.calls[0]?.args).toEqual(["plain failure", undefined, "Skein"]);
  });

  it("falls back to log() when the target implements no debug()", () => {
    const target = capturingLoggerService();
    // `debug` is optional on Nest's `LoggerService`; dropping the line would be the wrong answer.
    const withoutDebug: LoggerService = { log: target.log, error: target.error, warn: target.warn };
    createNestLogger({ logger: withoutDebug }).debug("still visible");
    expect(target.calls).toEqual([{ level: "log", args: ["still visible", "Skein"] }]);
  });

  it("renders non-error meta into the message", () => {
    const target = capturingLoggerService();
    createNestLogger({ logger: target }).info("Background run succeeded", { run_id: "r1" });
    expect(target.calls[0]?.args[0]).toContain("run_id=r1");
  });
});

// The tests above inject a mock `LoggerService`, which cannot see what the *default* target does to
// the argument list. `@nestjs/common`'s `Logger` appends its own `this.context` to every call, so a
// bridge that both constructs it with a context and passes one explicitly sends it twice — and Nest
// reads the trailing copy as the stack. That is the default path for every embedded app, so it gets
// tested against the real facade rather than a stand-in.
describe("createNestLogger — against the real Nest facade", () => {
  /** Install a capturing `LoggerService` as Nest's global, the way `app.useLogger()` does. */
  function withGlobalLogger<T>(run: (calls: { level: string; args: unknown[] }[]) => T): T {
    const calls: { level: string; args: unknown[] }[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]): void => {
        calls.push({ level, args });
      };
    const previous = (NestLoggerClass as unknown as { staticInstanceRef?: unknown })
      .staticInstanceRef;
    NestLoggerClass.overrideLogger({
      log: record("log"),
      error: record("error"),
      warn: record("warn"),
      debug: record("debug"),
    });
    try {
      return run(calls);
    } finally {
      (NestLoggerClass as unknown as { staticInstanceRef?: unknown }).staticInstanceRef = previous;
    }
  }

  it("sends the context exactly once, keeping the stack slot free", () => {
    withGlobalLogger((calls) => {
      createNestLogger().error("Graph run failed", failureReport());

      const args = calls[0]?.args as unknown[];
      // Not [message, stack, "Skein", "Skein"] — the duplicate would become the stack.
      expect(args).toHaveLength(3);
      expect(String(args[1])).toContain("Error: graph exploded");
      expect(args[2]).toBe("Skein");
    });
  });

  it("does not emit a stray extra context argument on info", () => {
    withGlobalLogger((calls) => {
      createNestLogger().info("Background run succeeded");
      expect(calls[0]?.args).toEqual(["Background run succeeded", "Skein"]);
    });
  });

  it("routes through whatever the host installed later, honoring useLogger()", () => {
    // Built before the host swaps its logger in — the ordering a Nest module factory always has.
    const logger = createNestLogger();
    withGlobalLogger((calls) => {
      logger.warn("webhook failed");
      expect(calls).toEqual([{ level: "warn", args: ["webhook failed", "Skein"] }]);
    });
  });
});

// `createNestServer` keeps Nest's bootstrap chatter off with `NestFactory.create({ logger: false })`,
// which silences the *global* Logger facade. Its default logger therefore targets a directly
// constructed `ConsoleLogger`. If that global override ever reached instances too, a standalone
// server would go silent about failed runs — so pin the assumption rather than trust it.
describe("ConsoleLogger under a global logger override", () => {
  it("still writes when the global Nest logger is disabled", () => {
    const written: unknown[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(chunk);
      return true;
    });
    const globals = NestLoggerClass as unknown as { staticInstanceRef?: unknown };
    const previous = globals.staticInstanceRef;
    try {
      // What `NestFactory.create(root, { logger: false })` does internally.
      NestLoggerClass.overrideLogger(false);
      createNestLogger({ logger: new ConsoleLogger("Skein") }).error("Graph run failed");
      expect(written.join("")).toContain("Graph run failed");
    } finally {
      // Restored by assignment, not `overrideLogger(undefined)` — that takes the non-object branch
      // and *disables* the global logger rather than putting the default back.
      globals.staticInstanceRef = previous;
      stderr.mockRestore();
    }
  });
});

// Bridge skein's `Logger` onto NestJS's `LoggerService`, so a failed graph run appears in the host
// app's own logs, formatted like everything else it prints.
//
// This is `SkeinModule`'s default, and defaulting it on is safe precisely because `@nestjs/common`'s
// `Logger` is a *facade*: it forwards to whatever the host configured via `app.useLogger()` or
// `NestFactory.create({ logger })`, including `logger: false` for silence. Skein borrows the host's
// logging decisions rather than imposing its own — which is why Express and Next.js, whose frameworks
// own no logger, get no default at all.

import { Logger as NestLogger, type LoggerService } from "@nestjs/common";
import { isRunFailureReport, type Logger } from "@skein-js/agent-protocol";
import { describeError, formatLogMeta, runFailureIdentity } from "@skein-js/server-kit";

/** The context label skein's lines carry in Nest's output (`[Skein]`). */
const DEFAULT_CONTEXT = "Skein";

export interface NestLoggerOptions {
  /** Context shown against every line. Defaults to `"Skein"`. */
  context?: string;
  /**
   * Where to write. Defaults to a `Logger` from `@nestjs/common`, i.e. whatever the host app
   * configured. Pass an explicit `LoggerService` (a `ConsoleLogger`, nestjs-pino, …) to write
   * somewhere the global Nest logger doesn't reach.
   */
  logger?: LoggerService;
}

/**
 * A skein `Logger` that writes through NestJS.
 *
 * Nest reads a call's trailing arguments positionally — the last string is the *context*, and for
 * `error` the one before it is the *stack*. So meta is flattened here and the slots are filled
 * explicitly rather than letting an arbitrary `meta` land in a slot Nest would reinterpret. A failed
 * run's stack goes in the stack slot, where Nest renders it as a trace instead of an opaque blob.
 */
export function createNestLogger(options: NestLoggerOptions = {}): Logger {
  const context = options.context ?? DEFAULT_CONTEXT;
  // Deliberately constructed WITHOUT a context. `Logger`'s methods append their own `this.context` to
  // the argument list (`optionalParams.concat(this.context)`), so a context passed both ways arrives
  // twice — and Nest, reading those arguments positionally, would take the trailing copy as the
  // *stack*, printing "Skein" where a failed run's trace belongs. Passing it explicitly below is the
  // half that also works for an injected `LoggerService`, so this is the half that goes.
  const target = options.logger ?? new NestLogger();

  /** Append flattened meta to the message; used for every level except a stack-carrying `error`. */
  const withMeta = (message: string, meta: unknown): string => {
    const rendered = formatLogMeta(meta);
    return rendered ? `${message}\n${rendered}` : message;
  };

  return {
    // `debug` is optional on `LoggerService`, so fall back to `log` rather than dropping the line.
    debug: (message, meta) => {
      const text = withMeta(message, meta);
      if (target.debug) target.debug(text, context);
      else target.log(text, context);
    },
    info: (message, meta) => target.log(withMeta(message, meta), context),
    warn: (message, meta) => target.warn(withMeta(message, meta), context),
    error: (message, meta) => {
      // Put the stack in Nest's stack slot and keep the identity row on the message, so the output
      // reads as a normal Nest error rather than one long string. `undefined` is a valid stack slot.
      if (isRunFailureReport(meta)) {
        target.error(`${message}\n${runFailureIdentity(meta)}`, describeError(meta.error), context);
        return;
      }
      if (meta instanceof Error) {
        target.error(message, describeError(meta), context);
        return;
      }
      target.error(withMeta(message, meta), undefined, context);
    },
  };
}

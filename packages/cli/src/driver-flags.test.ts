// `skein start` used to default to the in-memory drivers, with only the generated Dockerfile's CMD
// flipping them — so a CMD override, or a hand-rolled `docker run`, produced a production server whose
// queue was process-local and whose state vanished on restart. These are the assertions that keep that
// closed; `index.ts` itself has no test, because importing it parses argv and runs a command.

import { describe, expect, it } from "vitest";

import {
  parseQueue,
  parseStartQueue,
  parseStartStore,
  parseStore,
  START_REQUIRES_DURABLE,
} from "./driver-flags.js";

describe("start driver flags", () => {
  it("rejects the in-memory drivers", () => {
    expect(() => parseStartStore("memory")).toThrow(/Must be one of: postgres/);
    expect(() => parseStartQueue("memory")).toThrow(/Must be one of: redis/);
  });

  // The flags are kept rather than removed precisely so an image built by an older `skein build` —
  // whose CMD passes them explicitly — still boots.
  it("accepts the values an older image's CMD passes", () => {
    expect(parseStartStore("postgres")).toBe("postgres");
    expect(parseStartQueue("redis")).toBe("redis");
  });

  // Commander prints only the message, so "Must be one of: postgres." alone would leave someone who
  // typed `--store memory` with no idea what to do instead.
  it("names the alternative in the rejection", () => {
    expect(() => parseStartStore("memory")).toThrow(/skein dev/);
    expect(START_REQUIRES_DURABLE).toContain("skein dev --store postgres --queue redis");
  });

  it("rejects an unknown driver too", () => {
    expect(() => parseStartStore("sqlite")).toThrow();
    expect(() => parseStartQueue("sqs")).toThrow();
  });
});

describe("dev driver flags", () => {
  // `dev` is the no-infrastructure path and must keep accepting both — it is where the restriction
  // above points people.
  it("still accepts memory and the durable drivers", () => {
    expect(parseStore("memory")).toBe("memory");
    expect(parseStore("postgres")).toBe("postgres");
    expect(parseQueue("memory")).toBe("memory");
    expect(parseQueue("redis")).toBe("redis");
  });

  // No hint here: `--store sqlite` under `dev` is a typo, not someone reaching for a documented
  // combination, so the allowed-values list is the whole answer.
  it("rejects an unknown driver without the start hint", () => {
    expect(() => parseStore("sqlite")).toThrow(/Must be one of: memory, postgres\.$/);
  });
});

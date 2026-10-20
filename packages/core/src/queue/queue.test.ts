import { expectTypeOf, it } from "vitest";

import type { RunFrame, StreamMode } from "../index.js";

it("keeps the existing event discriminant when subgraph namespace metadata is added", () => {
  expectTypeOf<RunFrame["event"]>().toEqualTypeOf<StreamMode | "error">();
  expectTypeOf<{ seq: number; event: "updates"; data: unknown }>().toExtend<RunFrame>();
});

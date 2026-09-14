export const channel = {
  name: "fixture",
  verify: () => ({ identity: "fixture:test" }),
  parseEvent: () => ({ kind: "ignore" as const }),
};

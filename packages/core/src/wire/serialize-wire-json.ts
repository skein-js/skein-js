// Serialize protocol payloads to the Agent Protocol's JSON wire shape. A bare `JSON.stringify`
// turns LangChain `BaseMessage` instances into their `Serializable` constructor form
// (`{ lc, type: "constructor", id: ["langchain_core","messages","AIMessage"], kwargs }`), which the
// LangGraph clients (`@langchain/langgraph-sdk`, `useStream`, Agent Chat UI) can't read — they
// expect the flattened form `{ type: "ai", content, ... }`. LangGraph's own server flattens via a
// `toDict()` replacer; we mirror that here so streamed and returned messages match its wire format.

/** An object that knows how to flatten itself to the wire dict — every `BaseMessage` implements it. */
interface WireDictConvertible {
  toDict(): { type: string; data: Record<string, unknown> };
}

function isWireDictConvertible(value: unknown): value is WireDictConvertible {
  // No `"toDict" in value` guard: it is redundant — a value without `toDict` reads as `undefined`,
  // which the `typeof` check already rejects — and `in` walks the prototype chain on every key of
  // every nested object. This runs once per key of every outbound payload, so on a `values`-mode
  // frame carrying a whole message history that is tens of thousands of chain walks per frame;
  // dropping it measured ~6% off serialization for identical output.
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { toDict?: unknown }).toDict === "function"
  );
}

/**
 * `JSON.stringify` for outbound protocol payloads. Any value exposing `toDict()` (i.e. a LangChain
 * message) is flattened to `{ ...data, type }` — the shape LangGraph clients expect.
 *
 * The replacer reads `this[key]` rather than its `value` argument on purpose: `JSON.stringify`
 * applies an object's own `toJSON()` *before* calling the replacer, and `BaseMessage.toJSON()`
 * already produces the unwanted constructor form. `this[key]` is the original message, so we can
 * intercept it and call `toDict()` instead.
 */
export function serializeWireJson(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: Record<string, unknown>, key: string, serialized: unknown) {
      const raw = this[key];
      if (isWireDictConvertible(raw)) {
        const { type, data } = raw.toDict();
        return { ...data, type };
      }
      return serialized;
    },
  );
}

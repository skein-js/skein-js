// How the console finds its server. This is the one piece of the SPA that is pure logic and easy to
// get subtly wrong: the same bundle is served from `/console/`, from a host app's `/api/console/`,
// and from a static host pointed at a remote deployment, and each must resolve a different base.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveApiKey, resolveApiUrl, setApiKey, setApiUrl } from "./api";

/** Put the page at a URL, the way the browser would have. */
function visit(url: string) {
  window.history.replaceState({}, "", url);
}

beforeEach(() => {
  window.localStorage.clear();
  visit("/console/");
});

afterEach(() => {
  window.localStorage.clear();
});

describe("resolveApiUrl", () => {
  it("targets the server root when mounted at /console/", () => {
    expect(resolveApiUrl()).toBe(window.location.origin);
  });

  it("targets the host app's prefix when mounted beneath one", () => {
    // A Next.js app mounting skein at /api serves the console at /api/console.
    visit("/api/console/");
    expect(resolveApiUrl()).toBe(`${window.location.origin}/api`);
  });

  it("ignores a filename in the path", () => {
    visit("/console/index.html");
    expect(resolveApiUrl()).toBe(window.location.origin);
  });

  it("takes a confirmed ?baseUrl= over the origin, and remembers it", () => {
    // Cross-origin needs a human to agree first — see the API-key-scoping tests for why.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    visit("/console/?baseUrl=https://agents.example.com");
    expect(resolveApiUrl()).toBe("https://agents.example.com");

    // The query is gone after hash navigation; the choice must survive it — without re-prompting.
    confirmSpy.mockClear();
    visit("/console/#/threads");
    expect(resolveApiUrl()).toBe("https://agents.example.com");
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("takes a same-origin ?baseUrl= without prompting", () => {
    // A link that points the console at its own origin is not a redirection attack.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    visit(`/console/?baseUrl=${window.location.origin}/api`);
    expect(resolveApiUrl()).toBe(`${window.location.origin}/api`);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("strips trailing slashes, so paths are joined with exactly one", () => {
    setApiUrl("https://agents.example.com/");
    expect(resolveApiUrl()).toBe("https://agents.example.com");
  });

  it("falls back to the origin once an override is cleared", () => {
    setApiUrl("https://agents.example.com");
    setApiUrl(undefined);
    expect(resolveApiUrl()).toBe(window.location.origin);
  });
});

describe("setApiKey", () => {
  it("clears rather than stores an empty key", () => {
    setApiKey("secret");
    setApiKey("");
    expect(window.localStorage.getItem("skein-console:apiKey")).toBeNull();
  });
});

describe("API key scoping", () => {
  it("is only sent to the server it was entered for", () => {
    // The attack this closes: a link like `…/console/?baseUrl=https://attacker.example` repoints the
    // console, and the first thing it does on load is call /info — which would carry this key.
    visit("/console/");
    setApiKey("secret");
    expect(resolveApiKey()).toBe("secret");

    setApiUrl("https://attacker.example");
    expect(resolveApiKey()).toBeUndefined();

    setApiUrl(undefined);
    expect(resolveApiKey()).toBe("secret");
  });

  it("forgets the owner when the key is cleared", () => {
    visit("/console/");
    setApiKey("secret");
    setApiKey(undefined);
    expect(window.localStorage.getItem("skein-console:apiKeyFor")).toBeNull();
  });

  it("does not adopt a cross-origin ?baseUrl= without confirmation", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    visit("/console/?baseUrl=https://attacker.example");
    expect(resolveApiUrl()).toBe(window.location.origin);
    expect(confirmSpy).toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    visit("/console/?baseUrl=https://agents.example");
    expect(resolveApiUrl()).toBe("https://agents.example");
    confirmSpy.mockRestore();
  });
});

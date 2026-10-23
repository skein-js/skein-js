import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanggraphJson } from "@skein-js/config";
import { expect, it } from "vitest";

import { loadConfigHttpHandler } from "./config-http-handler.js";
import { withNativePath } from "./native-http.js";

it("serves a compiled UI at a mount prefix and escapes bootstrap component names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-ui-"));
  try {
    await mkdir(join(directory, "ui/public/agent"), { recursive: true });
    await writeFile(
      join(directory, "ui/schemas.json"),
      JSON.stringify({ agent: { assets: ["entrypoint.js", "entrypoint.css"] } }),
    );
    await writeFile(
      join(directory, "ui/public/agent/entrypoint.js"),
      "window.__LGUI_agent={render(){}};",
    );
    await writeFile(join(directory, "ui/public/agent/entrypoint.css"), "body{color:red}");
    const handler = await loadConfigHttpHandler(
      { graphs: {}, ui: { agent: "./ui/public/agent/entrypoint.js" } } as LanggraphJson,
      { configDir: directory },
    );
    const native = withNativePath(
      new Request("https://example.com/api/ui/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: '" onload="alert(1)' }),
      }),
      "/ui/agent",
    );
    const response = await handler!(native);
    const html = await response!.text();
    expect(html).toContain('src="https://example.com/api/ui/agent/entrypoint.js"');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('name=" onload="alert');
    const asset = await handler!(new Request("https://example.com/ui/agent/entrypoint.css"));
    expect(asset!.headers.get("content-type")).toBe("text/css");
    expect(await asset!.text()).toBe("body{color:red}");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

it("rebuilds development UI through the upstream watcher without retaining a test process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "skein-ui-watch-"));
  const filename = path.join(directory, "ui.tsx");
  await writeFile(filename, 'export default {card:()=>"INITIAL_MARKER"};');
  const entry = pathToFileURL(path.join(process.cwd(), "dist/index.js")).href;
  const source = `import {createInterface} from 'node:readline';import {loadConfigHttpHandler} from ${JSON.stringify(entry)};
    const handler=await loadConfigHttpHandler({graphs:{},ui:{agent:'./ui.tsx'}},{configDir:${JSON.stringify(directory)}});
    const report=async()=>{const html=await (await handler(new Request('http://localhost/ui/agent',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"card"}'}))).text();const asset=/<script src="([^"]+)"/.exec(html)[1];const code=await (await handler(new Request(asset))).text();console.log(JSON.stringify({initial:code.includes('INITIAL_MARKER'),updated:code.includes('UPDATED_MARKER')}));};
    await report();for await(const line of createInterface({input:process.stdin})){if(line==='probe')await report();}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const probe = setInterval(() => {
    if (!child.stdin.destroyed) child.stdin.write("probe\n");
  }, 200);
  try {
    await expect
      .poll(() => output, { timeout: 15_000, message: errors })
      .toContain('"initial":true');
    await writeFile(filename, 'export default {card:()=>"UPDATED_MARKER"};');
    await expect
      .poll(() => output, { timeout: 15_000, message: errors })
      .toContain('"updated":true');
  } catch (error) {
    throw new Error(`UI watch child failed: ${errors}`, { cause: error });
  } finally {
    clearInterval(probe);
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

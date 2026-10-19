import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { packWorkspace, root, run, installConsumer, copyTree } from "./pack-local-consumer.mjs";
const host = process.argv[2];
const interactive = process.argv.includes("--interactive");
const envArgument = process.argv.find((value) => value.startsWith("--env-file="));
if (envArgument) process.loadEnvFile(path.resolve(root, envArgument.slice("--env-file=".length)));
if (!["electron", "tauri"].includes(host)) throw new Error("Expected electron or tauri");
console.log("Packed-consumer npm version:");
run("npm", ["--version"]);
const project = path.join(root, "examples", `desktop-${host}`);
const require = createRequire(path.join(project, "package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), `skein-packed-${host}-`));
const consumer = path.join(temporary, "app");
async function launch(executable, args = [], extra = {}) {
  const environment = {
    ...process.env,
    ...extra,
    ...(!interactive ? { SKEIN_EXAMPLE_SMOKE: "1" } : {}),
  };
  if (interactive) delete environment.SKEIN_EXAMPLE_SMOKE;
  delete environment.ELECTRON_RUN_AS_NODE;
  const { realpath } = await import("node:fs/promises");
  const child = spawn(await realpath(executable), args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
  if (interactive)
    console.log(
      `\n${host === "electron" ? "Daybook" : "Reading Room"} is open. Close the application to stop this command.\n`,
    );
  const timer = interactive ? undefined : setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (timer) clearTimeout(timer);
  if (code !== 0 || (!interactive && !output.includes(`PACKAGED_${host.toUpperCase()}_OK`)))
    throw new Error(`Packaged ${host} failed (${code}): ${output}`);
}
try {
  const packed = packWorkspace(path.join(temporary, "packages"));
  const original = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  const manifest = installConsumer(consumer, { ...original, devDependencies: undefined }, packed);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  copyTree(path.join(project, "dist"), path.join(consumer, "dist"));
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumer });
  if (host === "electron") {
    const { rebuild } = await import(pathToFileURL(require.resolve("@electron/rebuild")).href);
    const electronVersion = require("electron/package.json").version;
    await rebuild({
      buildPath: consumer,
      electronVersion,
      arch: process.arch,
      onlyModules: ["better-sqlite3"],
      force: true,
    });
    const { packager } = await import(pathToFileURL(require.resolve("@electron/packager")).href);
    const outputs = await packager({
      dir: consumer,
      out: path.join(temporary, "release"),
      name: "Daybook",
      electronVersion,
      asar: false,
      appBundleId: "dev.skein.local-example.electron",

      overwrite: true,
      // npm has already installed production dependencies only, including peer dependencies.
      // A second packager prune can discard those peers.
      prune: false,
      platform: process.platform,
      arch: process.arch,
    });
    if (process.platform === "darwin") {
      const bundle = path.join(outputs[0], "Daybook.app");
      // Generated local proof only. Shipping applications choose their own signing/notarization.
      run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
      run("codesign", ["--verify", "--deep", "--strict", bundle]);
    }
    const packagedRoot =
      process.platform === "darwin"
        ? path.join(outputs[0], "Daybook.app/Contents/Resources/app")
        : path.join(outputs[0], "resources/app");
    // Detect missing packaged dependencies before opening a native application.
    run(
      process.execPath,
      ["--input-type=module", "-e", "await import('@skein-js/example-local-workflow')"],
      { cwd: packagedRoot },
    );
    const executable =
      process.platform === "darwin"
        ? path.join(outputs[0], "Daybook.app/Contents/MacOS/Daybook")
        : path.join(outputs[0], process.platform === "win32" ? "Daybook.exe" : "Daybook");
    await launch(executable, process.platform === "linux" && !interactive ? ["--no-sandbox"] : []);
  } else {
    if (Number(process.versions.node.split(".")[0]) !== 24)
      throw new Error("Build the packaged Node 24 sidecar using Node 24.");
    const backend = path.join(project, "backend");
    await rm(backend, { recursive: true, force: true });
    await mkdir(backend, { recursive: true });
    copyTree(consumer, backend);
    // Official portable Node distribution, verified against its published SHA-256 manifest.
    const version = "24.15.0";
    const platform = process.platform;
    const architecture = process.arch;
    const basename = `node-v${version}-${platform === "win32" ? "win" : platform}-${architecture}`;
    const archive = `${basename}.${platform === "win32" ? "zip" : "tar.gz"}`;
    const base = `https://nodejs.org/dist/v${version}/`;
    const response = await fetch(base + archive);
    if (!response.ok) throw new Error(`Node download: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sumsResponse = await fetch(base + "SHASUMS256.txt");
    if (!sumsResponse.ok) throw new Error("Missing Node checksums");
    const expected = (await sumsResponse.text())
      .split("\n")
      .find((line) => line.trim().endsWith(`  ${archive}`))
      ?.split(/\s+/)[0];
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Node archive checksum mismatch");
    const saved = path.join(temporary, archive);
    await writeFile(saved, bytes);
    if (platform === "win32")
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${saved.replaceAll("'", "''")}' -DestinationPath '${temporary.replaceAll("'", "''")}'`,
      ]);
    else run("tar", ["-xzf", saved, "-C", temporary]);

    const { copyFile, chmod } = await import("node:fs/promises");
    await copyFile(
      path.join(temporary, basename, "LICENSE"),
      path.join(backend, "NODE-LICENSE.txt"),
    );
    const executable = path.join(backend, platform === "win32" ? "node.exe" : "node");
    await copyFile(
      path.join(temporary, basename, platform === "win32" ? "node.exe" : "bin/node"),
      executable,
    );
    if (platform !== "win32") await chmod(executable, 0o755);
    // Keep the backend separate from frontend resources and with its native addon tree intact.
    await copyFile(path.join(backend, "dist/backend.js"), path.join(backend, "backend.js"));
    run(
      "pnpm",
      [
        "exec",
        "tauri",
        "build",
        "--bundles",
        platform === "darwin" ? "app" : platform === "linux" ? "appimage" : "nsis",
      ],
      { cwd: project },
    );
    const release = path.join(project, "src-tauri/target/release");
    if (platform === "darwin")
      await launch(
        path.join(release, "bundle/macos/Reading Room.app/Contents/MacOS/skein-local-example"),
      );
    else if (platform === "linux") {
      const images = await readdir(path.join(release, "bundle/appimage"));
      const image = images.find((name) => name.endsWith(".AppImage"));
      if (!image) throw new Error("No packaged AppImage");
      await launch(path.join(release, "bundle/appimage", image), [], {
        APPIMAGE_EXTRACT_AND_RUN: "1",
      });
    } else {
      const installers = await readdir(path.join(release, "bundle/nsis"));
      const installer = installers.find((name) => name.endsWith("-setup.exe"));
      if (!installer) throw new Error("No packaged installer");
      const installed = path.join(temporary, "installed");
      run(path.join(release, "bundle/nsis", installer), ["/S", `/D=${installed}`]);
      await launch(path.join(installed, "skein-local-example.exe"));
    }
  }
} finally {
  if (process.env["SKEIN_KEEP_CONSUMER"] === "1") console.log(`Consumer retained: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
}

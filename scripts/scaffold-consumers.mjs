#!/usr/bin/env node
// Current-commit consumers. Registry smoke remains a separate CI job.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "prettier";

import { packWorkspace, root, run, installConsumer } from "./pack-local-consumer.mjs";

const catalog = JSON.parse(readFileSync(path.join(root, "scripts/scaffold-cases.json"), "utf8"));
const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.find((argument) => argument.startsWith(name + "="))?.slice(name.length + 1) ??
  (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const packDirectory = path.resolve(flag("--packs", path.join(root, "dist/scaffold-packs")));
const mode = args[0];
if (mode === "prepare-managers") {
  const directory = path.resolve(flag("--directory", path.join(tmpdir(), "skein-scaffold-tools")));
  run("npm", [
    "install",
    "--prefix",
    directory,
    "--no-audit",
    "--no-fund",
    "npm@" + catalog.npmVersion,
  ]);
  process.stdout.write(
    "Set SKEIN_CONSUMER_NPM_CLI=" + path.join(directory, "node_modules/npm/bin/npm-cli.js") + "\n",
  );
  process.exit(0);
}
function writeJson(filename, contents) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(contents, null, 2) + "\n");
}
if (mode === "pack") {
  const packed = packWorkspace(packDirectory);
  writeJson(
    path.join(packDirectory, "index.json"),
    Object.fromEntries(
      Object.entries(packed).map(([name, filename]) => [name, path.basename(filename)]),
    ),
  );
  for (const name of ["@skein-js/nx", "create-skein-js"]) {
    const archive = packed[name];
    const manifest = JSON.parse(
      run("tar", ["-xOf", archive, "package/package.json"], {
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      }).stdout,
    );
    if (manifest.dependencies?.["@skein-js/scaffold"])
      throw new Error("Private runtime dependency in " + name);
    for (const filename of ["dist/index.js", "dist/index.d.ts"]) {
      const source = run("tar", ["-xOf", archive, "package/" + filename], {
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      }).stdout;
      if (/from\s*["']@skein-js\/scaffold/.test(source))
        throw new Error("Private import in " + name + "/" + filename);
    }
  }
  writeFileSync(
    path.join(packDirectory, "matrix.json"),
    JSON.stringify({
      include: catalog.cases.map((row) => ({ id: row.id, node: row.node })),
    }) + "\n",
  );
  process.exit(0);
}
if (mode === "matrix") {
  // One runner per case; all artifacts come from the single pack job.
  process.stdout.write(
    JSON.stringify({ include: catalog.cases.map((row) => ({ id: row.id, node: row.node })) }),
  );
  process.exit(0);
}
const overrides = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(path.join(packDirectory, "index.json"), "utf8"))).map(
    ([name, filename]) => [name, path.join(packDirectory, filename)],
  ),
);
function install(directory, manager) {
  run(
    manager,
    manager === "yarn"
      ? ["install"]
      : [
          "install",
          ...(manager === "npm"
            ? ["--no-audit", "--no-fund"]
            : manager === "pnpm"
              ? ["--no-frozen-lockfile"]
              : ["--network-concurrency", "8"]),
        ],
    {
      cwd: directory,
      timeout: 300_000,
      env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
    },
  );
}
async function substitute(directory, manager) {
  const filename = path.join(directory, "package.json");
  const original = JSON.parse(readFileSync(filename, "utf8"));
  const converted = installConsumer(directory, original, overrides);
  if (manager === "pnpm") {
    converted.pnpm = {
      ...original.pnpm,
      overrides: converted.overrides,
    };
    delete converted.overrides;
  }
  if (manager === "yarn") {
    converted.resolutions = converted.overrides;
    delete converted.overrides;
  }
  if (manager === "bun") converted.trustedDependencies = ["better-sqlite3", "esbuild", "nx"];
  writeFileSync(
    filename,
    await format(JSON.stringify(converted), { filepath: filename, printWidth: 100 }),
  );
}
function locatePackage(owner, name) {
  const resolver = createRequire(owner);
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const filename = path.join(directory, name, "package.json");
    if (existsSync(filename)) return realpathSync(filename);
  }
  throw new Error("Cannot resolve " + name + " from " + owner);
}
function verifyProvenance(directory, requireRuntime = true) {
  const seen = new Set();
  const visit = (filename) => {
    if (seen.has(filename)) return;
    seen.add(filename);
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    if (overrides[manifest.name]) {
      const packedManifest = JSON.parse(
        run("tar", ["-xOf", overrides[manifest.name], "package/package.json"], {
          stdio: "pipe",
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }).stdout,
      );
      for (const field of [
        "version",
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "exports",
        "bin",
        "engines",
      ]) {
        const normalize = (value) =>
          field !== "exports" && value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
              )
            : value;
        if (
          JSON.stringify(normalize(manifest[field])) !==
          JSON.stringify(normalize(packedManifest[field]))
        )
          throw new Error(
            "Package metadata differs from current artifact: " + manifest.name + "/" + field,
          );
      }

      const expected = run("tar", ["-xOf", overrides[manifest.name], "package/dist/index.js"], {
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
      }).stdout;
      const actual = readFileSync(path.join(path.dirname(filename), "dist/index.js"));
      const digest = (value) => createHash("sha256").update(value).digest("hex");
      if (digest(expected) !== digest(actual))
        throw new Error("Registry/stale artifact resolved for " + manifest.name);
    }
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...(filename === path.join(directory, "package.json") ? manifest.devDependencies : {}),
    })) {
      if (name === "skein-js" || name.startsWith("@skein-js/"))
        visit(locatePackage(filename, name));
    }
  };
  visit(path.join(directory, "package.json"));
  if (requireRuntime && seen.size < 3)
    throw new Error("Transitive Skein provenance was not exercised.");
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function stop(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (server.exitCode === null && server.signalCode === null) process.kill(-server.pid, "SIGKILL");
}
async function exerciseServer(command, arguments_, directory, environment, port) {
  const server = spawn(command, arguments_, {
    cwd: directory,
    detached: true,
    stdio: "inherit",
    env: environment,
  });
  try {
    const base = "http://127.0.0.1:" + port;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null)
        throw new Error("Server exited before readiness: " + server.exitCode);
      try {
        if ((await fetch(base + "/ok", { signal: AbortSignal.timeout(2000) })).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Server never became ready");
    const post = async (route, body) => {
      const response = await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(route + ": " + (await response.text()));
      return response.json();
    };
    const thread = await post("/threads", {});
    const reply = await post("/threads/" + thread.thread_id + "/runs/wait", {
      assistant_id: "echo",
      input: { messages: [{ role: "user", content: "matrix" }] },
    });
    if (reply.messages?.at(-1)?.content !== "echo: matrix")
      throw new Error("Echo request failed: " + JSON.stringify(reply));
  } finally {
    await stop(server);
  }
}
function scaffoldRoot(directory, row) {
  const packageManager = {
    npm: "npm@10.9.2",
    pnpm: "pnpm@9.15.0",
    yarn: "yarn@4.9.2",
    bun: "bun@1.3.0",
  }[row.packageManager];
  const manifest = {
    name: "consumer-workspace",
    private: true,
    packageManager,
    scripts: { sentinel: "echo retained" },
    devDependencies: {},
  };
  if (row.layout !== "integrated") manifest.workspaces = ["packages/*"];
  if (row.entry === "nx") manifest.devDependencies.nx = "23.2.1";
  if (["eslint", "both"].includes(row.tooling)) {
    Object.assign(manifest.devDependencies, {
      eslint: "^9.17.0",
      "@eslint/js": "^9.17.0",
      "typescript-eslint": "^8.18.1",
    });
    writeFileSync(
      path.join(directory, "eslint.config.mjs"),
      'import js from "@eslint/js";\nimport tseslint from "typescript-eslint";\n\nexport default tseslint.config(\n  { ignores: ["**/.skein/**", "**/node_modules/**"] },\n  js.configs.recommended,\n  ...tseslint.configs.recommended,\n);\n',
    );
  }
  if (["prettier", "both"].includes(row.tooling)) {
    manifest.devDependencies.prettier = "^3.9.6";
    writeJson(path.join(directory, ".prettierrc.json"), { printWidth: 100 });
    writeFileSync(
      path.join(directory, ".prettierignore"),
      "node_modules/\n.skein/\n**/.skein/\n.nx/\n",
    );
  }
  if (row.packageManager === "pnpm" && row.layout !== "integrated")
    writeFileSync(
      path.join(directory, "pnpm-workspace.yaml"),
      "# preserve registration\npackages:\n  - packages/*\n",
    );
  if (row.packageManager === "yarn")
    writeFileSync(path.join(directory, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  if (row.entry === "nx") {
    manifest.devDependencies["@skein-js/nx"] = "file:" + overrides["@skein-js/nx"];
    writeJson(path.join(directory, "nx.json"), {
      $schema: "./node_modules/nx/schemas/nx-schema.json",
    });
    writeJson(path.join(directory, "tsconfig.base.json"), { compilerOptions: { strict: true } });
  }
  writeFileSync(path.join(directory, ".nvmrc"), row.node + "\n");
  writeJson(path.join(directory, "package.json"), manifest);
}
async function exerciseCase(row) {
  const expectedMajor = row.node.split(".")[0];
  if (
    process.versions.node.split(".")[0] !== expectedMajor ||
    (expectedMajor === "22" && process.versions.node !== "22.12.0")
  )
    throw new Error(row.id + " requires Node " + row.node + "; running " + process.versions.node);
  const workspace = mkdtempSync(path.join(tmpdir(), "skein-" + row.id + "-"));
  const standalone = row.layout === "standalone";
  const project = path.join(workspace, standalone ? "agent" : "apps/agent");
  const manager = row.packageManager;
  const env = {
    ...process.env,
    NX_DAEMON: "false",
    NX_ISOLATE_PLUGINS: "false",
    GOOGLE_API_KEY: "dummy",
    OPENAI_API_KEY: "dummy",
    ANTHROPIC_API_KEY: "dummy",
  };
  let composeStarted = false;
  const composeProject = "skein-" + path.basename(workspace).toLowerCase();
  try {
    if (!standalone) scaffoldRoot(workspace, row);
    if (row.entry === "nx") {
      await substitute(workspace, manager);
      install(workspace, manager);
      run(
        process.execPath,
        [
          "-e",
          'const p=require("@skein-js/nx"); if(typeof p.generateApplication!=="function") throw new Error("Missing named generator");',
        ],
        { cwd: workspace, env },
      );
      const before = [
        "package.json",
        "pnpm-workspace.yaml",
        "nx.json",
        "tsconfig.base.json",
        "eslint.config.mjs",
        ".prettierrc.json",
      ]
        .filter((name) => existsSync(path.join(workspace, name)))
        .map((name) => [name, readFileSync(path.join(workspace, name), "utf8")]);
      run(
        manager,
        [
          "exec",
          "nx",
          "g",
          "@skein-js/nx:application",
          "--directory=apps/dry-run",
          "--dry-run",
          "--interactive=false",
        ],
        { cwd: workspace, env },
      );
      if (existsSync(path.join(workspace, "apps/dry-run")))
        throw new Error("Dry run wrote application files");
      for (const [name, contents] of before)
        if (readFileSync(path.join(workspace, name), "utf8") !== contents)
          throw new Error("Dry run changed " + name);
      run(
        manager,
        [
          "exec",
          "nx",
          "g",
          "@skein-js/nx:application",
          "--directory=apps/agent",
          "--provider=" + row.provider,
          "--storage=" + row.storage,
          ...(row.linting ? [] : ["--linting=false"]),
          "--interactive=false",
        ],
        { cwd: workspace, env },
      );
    } else {
      // Load the packed CLI, rather than checkout dist.
      const bootstrap = path.join(workspace, "bootstrap");
      mkdirSync(bootstrap);
      writeJson(path.join(bootstrap, "package.json"), {
        private: true,
        dependencies: { "create-skein-js": "file:" + overrides["create-skein-js"] },
      });
      install(bootstrap, "npm");
      run(
        process.execPath,
        [
          path.join(bootstrap, "node_modules/create-skein-js/dist/index.js"),
          project,
          "--provider",
          row.provider,
          "--storage",
          row.storage,
          "--pm",
          manager,
          ...(row.linting ? [] : ["--no-linting"]),
          "--no-install",
          "--no-git",
          "--yes",
        ],
        { cwd: workspace, env },
      );
    }
    if (row.entry === "nx") {
      writeFileSync(
        path.join(project, "src/plugin-types.ts"),
        'import type { generateApplication } from "@skein-js/nx";\n\nexport type ApplicationGenerator = typeof generateApplication;\n',
      );
    }
    if (row.storage === "sqlite") {
      const manifestPath = path.join(project, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const target of ["dev", "start"])
        manifest.scripts[target] += " --sqlite-path .skein/matrix.sqlite";
      writeFileSync(
        manifestPath,
        await format(JSON.stringify(manifest), { filepath: manifestPath, printWidth: 100 }),
      );
      if (row.entry === "nx") {
        const configurationPath = path.join(project, "project.json");
        const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
        for (const target of ["dev", "start"])
          configuration.targets[target].options.command = manifest.scripts[target];
        writeFileSync(
          configurationPath,
          await format(JSON.stringify(configuration), {
            filepath: configurationPath,
            printWidth: 100,
          }),
        );
      }
    }
    const graphFile = path.join(project, "src/echo-graph.ts");
    writeFileSync(
      graphFile,
      'if ("bun" in process.versions) throw new Error("Consumer graphs must execute on Node.");\n\n' +
        readFileSync(graphFile, "utf8"),
    );
    const installRoot = standalone ? project : workspace;
    if (manager === "yarn")
      writeFileSync(path.join(installRoot, ".yarnrc.yml"), "nodeLinker: node-modules\n");

    await substitute(installRoot, manager);
    if (!standalone && row.layout !== "integrated") await substitute(project, manager);
    install(installRoot, manager);
    verifyProvenance(installRoot, standalone || row.layout === "integrated");
    if (!standalone && row.layout !== "integrated") verifyProvenance(project);
    const execute = (target) => {
      if (row.entry === "nx")
        return run(manager, ["exec", "nx", "run", "apps-agent:" + target], { cwd: workspace, env });
      return run(manager, ["run", target], { cwd: project, env });
    };
    for (const target of [
      "typecheck",
      "test",
      ...(row.linting ? ["lint", "format:check"] : []),
      "build",
    ])
      execute(target);
    if (row.storage !== "sqlite") {
      run("docker", ["info"], { stdio: "ignore" }); // Required; absence is a failure.
      const postgres = await unusedPort(),
        redis = await unusedPort();
      const compose = path.join(project, "compose.dev.yaml");
      writeFileSync(
        compose,
        readFileSync(compose, "utf8")
          .replace("127.0.0.1:5432:5432", "127.0.0.1:" + postgres + ":5432")
          .replace("127.0.0.1:6379:6379", "127.0.0.1:" + redis + ":6379"),
      );
      env.POSTGRES_URI = "postgresql://postgres:postgres@127.0.0.1:" + postgres + "/skein";
      env.REDIS_URI = "redis://127.0.0.1:" + redis;
      composeStarted = true;
      run(
        "docker",
        ["compose", "-p", composeProject, "-f", "compose.dev.yaml", "up", "-d", "--wait"],
        { cwd: project },
      );
    }
    const devPort = await unusedPort();
    const invoke = (target) =>
      row.entry === "nx"
        ? [manager, ["exec", "nx", "run", "apps-agent:" + target], workspace]
        : [manager, ["run", target], project];
    const [devCommand, devArgs, devCwd] = invoke("dev");
    await exerciseServer(
      devCommand,
      [
        ...devArgs,
        ...(manager === "npm" && row.entry !== "nx" ? ["--"] : []),
        "--port",
        String(devPort),
      ],
      devCwd,
      env,
      devPort,
    );
    const startPort = await unusedPort();
    const [startCommand, startArgs, startCwd] = invoke("start");
    await exerciseServer(
      startCommand,
      startArgs,
      startCwd,
      { ...env, PORT: String(startPort) },
      startPort,
    );
    if (row.storage === "sqlite" && !existsSync(path.join(project, ".skein/matrix.sqlite")))
      throw new Error("Custom SQLite path was not honored.");
    process.stdout.write("PASS " + row.id + "\n");
  } catch (error) {
    process.stderr.write("Consumer retained at " + workspace + "\n");
    throw error;
  } finally {
    if (composeStarted)
      run("docker", ["compose", "-p", composeProject, "-f", "compose.dev.yaml", "down", "-v"], {
        cwd: project,
      });
  }
}
const selected = flag("--case", undefined);
const rows = catalog.cases.filter((row) => !selected || row.id === selected);
if (!rows.length) throw new Error("Unknown case " + selected);
let failures = 0;
for (const row of rows) {
  try {
    await exerciseCase(row);
  } catch (error) {
    failures++;
    process.stderr.write(row.id + ": " + error.stack + "\n");
  }
}
if (failures) throw new Error(failures + " consumer cases failed");

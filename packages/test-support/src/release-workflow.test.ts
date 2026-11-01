// Exercise the actual Actions shell, with a disposable registry: a beta suffix must not hide
// the recommended release or allow docs to deploy before every package is published.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// Reuse the pinned workspace tool's YAML parser; this guard is private and ships no dependency.
const workspaceRequire = createRequire(new URL("../../../package.json", import.meta.url));
const nxRequire = createRequire(workspaceRequire.resolve("nx/package.json"));
const { load } = nxRequire("@zkochan/js-yaml") as { load: (source: string) => Workflow };
const root = fileURLToPath(new URL("../../../", import.meta.url));
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Workflow {
  on: { workflow_dispatch?: { inputs: { release_tag: { required: boolean } } } };
  jobs: Record<
    string,
    { needs?: string | string[]; with?: Record<string, string>; steps?: Step[] }
  >;
}
function readWorkflow(name: string): Workflow {
  return load(readFileSync(path.join(root, `.github/workflows/${name}.yml`), "utf8"));
}
function requireJob(workflow: Workflow, name: string) {
  const job = workflow.jobs[name];
  if (!job) throw new Error(`Missing workflow job: ${name}`);
  return job;
}
const release = readWorkflow("release");
function releaseScript(name: string): string {
  const script = requireJob(release, "publish").steps?.find((step) => step.name === name)?.run;
  if (!script) throw new Error(`Missing release step: ${name}`);
  return script;
}
const fixtureDirectories: string[] = [];
afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function createRegistryFixture(published: boolean, latest: string, pendingReads = 0) {
  const directory = mkdtempSync(path.join(tmpdir(), "skein-release-"));
  fixtureDirectories.push(directory);
  mkdirSync(path.join(directory, "bin"));
  for (const [name, isPrivate] of [
    ["public", false],
    ["private", true],
  ] as const) {
    mkdirSync(path.join(directory, "packages", name), { recursive: true });
    writeFileSync(
      path.join(directory, "packages", name, "package.json"),
      JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0-beta.0", private: isPrivate }),
    );
  }
  writeFileSync(
    path.join(directory, "registry.json"),
    JSON.stringify({ published, latest, pendingReads }),
  );
  // Both executables refuse unexpected commands. No test can contact npm or publish a real package.
  writeFileSync(
    path.join(directory, "bin/npm"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FIXTURE_ROOT + '/registry.json';
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FIXTURE_ROOT + '/commands.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'view' && args[1].startsWith('@fixture/public')) {
  if (args[2] === 'version') { if (!state.published) process.exit(1); console.log('1.0.0-beta.0'); }
  else if (args[2] === 'dist-tags.latest') {
    console.log(state.pendingReads > 0 ? '0.23.0' : state.latest);
    if (state.pendingReads > 0) state.pendingReads--;
  }
  else process.exit(2);
} else if (args[0] === 'publish') {
  if (!args.includes('--provenance') || args[args.indexOf('--tag') + 1] !== 'latest') process.exit(2);
  state.published = true; state.latest = '1.0.0-beta.0';
} else if (args.join(' ') === 'dist-tag add @fixture/public@1.0.0-beta.0 latest') {
  state.latest = '1.0.0-beta.0';
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(state));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, "bin/pnpm"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'pack' || args[1] !== '--pack-destination') process.exit(2);
fs.writeFileSync(args[2] + '/fixture.tgz', 'fixture only');
`,
    { mode: 0o755 },
  );
  // Keep the real bounded polling loop, replacing wall-clock delays in this isolated fixture.
  writeFileSync(path.join(directory, "bin/sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    run(name: string) {
      return spawnSync("bash", ["-c", releaseScript(name)], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          // Nx forces colored output; the standalone Actions shell has plain node -p output.
          FORCE_COLOR: "0",
          PATH: `${directory}/bin:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          FIXTURE_ROOT: directory,
        },
      });
    },
    commands(): string[][] {
      return readFileSync(path.join(directory, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

describe("release source and deployment gates", () => {
  it("recovers an explicit release tag and keeps CI, publishing and docs on its resolved SHA", () => {
    expect(release.on.workflow_dispatch?.inputs.release_tag.required).toBe(true);
    for (const job of ["ci", "docs"]) {
      expect(requireJob(release, job).with?.source_ref).toBe(
        "${{ needs.resolve-release.outputs.sha }}",
      );
    }
    expect(
      requireJob(release, "publish").steps?.find((step) =>
        step.uses?.startsWith("actions/checkout"),
      )?.with?.ref,
    ).toBe("${{ needs.resolve-release.outputs.sha }}");
    expect(requireJob(release, "publish").needs).toContain("ci");
    expect(requireJob(release, "finalize-release").needs).toContain("publish");
    expect(requireJob(release, "finalize-release").steps?.map((step) => step.run)).toContain(
      'gh release edit "$RELEASE_TAG" --prerelease=false --latest',
    );
    expect(requireJob(release, "docs").needs).toContain("finalize-release");
  });

  it("propagates the released source through every reusable workflow checkout", () => {
    let checkouts = 0;
    for (const workflowName of ["ci", "local-deployment", "docs"]) {
      for (const job of Object.values(readWorkflow(workflowName).jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/checkout")) continue;
          expect(step.with?.ref).toBe("${{ inputs.source_ref || github.sha }}");
          checkouts++;
        }
      }
    }
    expect(checkouts).toBeGreaterThan(10);
    expect(requireJob(readWorkflow("ci"), "local-deployment").with?.source_ref).toBe(
      "${{ inputs.source_ref || github.sha }}",
    );
  });
});

// Actions runs these Bash commands on Ubuntu; Unix executable fixtures are not Windows binaries.
describe.skipIf(process.platform === "win32")("release registry behavior", () => {
  it("publishes a new beta explicitly as latest with provenance and skips private packages", () => {
    const fixture = createRegistryFixture(false, "0.23.0");
    const result = fixture.run("Pack and publish changed packages");
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.commands().filter((args) => args[0] === "publish")).toHaveLength(1);
    expect(fixture.commands().flat().join(" ")).not.toContain("@fixture/private");
    expect(fixture.run("Verify every public package is the recommended version").status).toBe(0);
  });

  it.each(["0.23.0", "1.0.0-beta.0"])(
    "safely retries an existing version when latest is %s",
    (latest) => {
      const fixture = createRegistryFixture(true, latest);
      const result = fixture.run("Pack and publish changed packages");
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.commands().filter((args) => args[0] === "publish")).toHaveLength(0);
      expect(fixture.commands().filter((args) => args[0] === "dist-tag")).toHaveLength(
        latest === "0.23.0" ? 1 : 0,
      );
      expect(fixture.run("Verify every public package is the recommended version").status).toBe(0);
    },
  );

  it("waits for asynchronous npm processing before finalizing the release", () => {
    const fixture = createRegistryFixture(true, "1.0.0-beta.0", 2);
    const result = fixture.run("Verify every public package is the recommended version");
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.commands()).toHaveLength(3);
    expect(fixture.commands().every((args) => args.includes("--prefer-online"))).toBe(true);
    expect(result.stdout).toContain("waiting for npm processing");
  });

  it("fails the publishing gate when a public package still points at another version", () => {
    const fixture = createRegistryFixture(true, "0.23.0");
    const result = fixture.run("Verify every public package is the recommended version");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected 1.0.0-beta.0");
    expect(fixture.commands()).toHaveLength(60);
    // Sixty real CLI fixture processes exercise the bound; sleep itself is virtualized above.
  }, 15_000);
});

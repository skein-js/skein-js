import { describe, expect, it } from "vitest";

import { DEFAULT_CONTAINER_PORT } from "../serve-env.js";

import { generateCompose } from "./compose.js";
import { generateDockerfile } from "./dockerfile.js";

describe("generateDockerfile", () => {
  it("pins the base image to the config's node_version and appends dockerfile_lines before CMD", () => {
    const out = generateDockerfile({
      nodeVersion: "22",
      dockerfileLines: ["RUN echo hello", "ENV FOO=bar"],
      port: 8123,
    });
    expect(out).toContain("FROM node:22-slim");
    expect(out).toContain("RUN echo hello");
    expect(out).toContain("ENV FOO=bar");
    expect(out.indexOf("RUN echo hello")).toBeLessThan(out.indexOf("CMD ["));
  });

  it("defaults to a supported node and boots the compiled artifact via `skein start`", () => {
    const out = generateDockerfile({ port: 8123 });
    // Node 24 is the current LTS; an omitted `node_version` follows that production baseline.
    expect(out).toContain("FROM node:24-slim");
    // Pre-built path: runs `skein start` (compiled JS), not `skein dev` (runtime TS transform).
    expect(out).toContain('"/app/node_modules/skein-js/dist/index.js", "start"');
    expect(out).not.toContain('"dev"');
    expect(out).toContain('"--store", "postgres"');
    expect(out).toContain('"--queue", "redis"');
    expect(out).toContain("EXPOSE 8123");
  });

  it("runs node directly so node — not npm — is PID 1 and receives SIGTERM", () => {
    // Under `npx skein`, PID 1 is npm: it forwards SIGTERM to a `sh -c` child and exits immediately,
    // killing the server mid-shutdown and stranding in-flight runs in a non-terminal status. Invoking
    // the entry directly keeps the signal path between the platform and skein's handler unbroken.
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain('CMD ["node", "/app/node_modules/skein-js/dist/index.js", "start"');
    expect(out).not.toContain('"npx"');
  });

  it("ships a slim image: prod-only install, no vite/tsx toolchain, no chown", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain("npm install --omit=dev --omit=optional --no-audit --no-fund");
    // No dev toolchain, no runtime TS transform, no vite cache to chown.
    expect(out).not.toContain("chown");
    expect(out).not.toMatch(/vite|tsx|corepack|--frozen-lockfile/);
  });

  it("runs as the non-root node user before the CMD", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain("USER node");
    expect(out.indexOf("USER node")).toBeLessThan(out.indexOf("CMD ["));
  });

  it("sets production env and enables source maps for readable stack traces", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain("ENV NODE_ENV=production");
    expect(out).toContain("ENV NODE_OPTIONS=--enable-source-maps");
  });

  it("declares a healthcheck against /ok on the bound port, spaced out", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain("HEALTHCHECK");
    expect(out).toContain("/ok");
    // 60s, not 30s: the probe spawns a whole Node process (a ~40MB transient spike), which is real
    // money in a 512Mi container — and wasted entirely on Cloud Run / k8s / ECS, which ignore
    // HEALTHCHECK and use their own probes.
    expect(out).toContain("--interval=60s");
  });

  it("enables the BuildKit cache mount and the syntax directive on line 1", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toMatch(/^# syntax=docker\/dockerfile:1/);
    expect(out).toContain("--mount=type=cache");
  });

  it("mounts an optional npmrc secret on the install step for private-registry auth", () => {
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain("--mount=type=secret,id=npmrc,target=/app/.npmrc");
    // The secret must be mounted for the dependency install, i.e. before the artifact `COPY . .`.
    expect(out.indexOf("--mount=type=secret,id=npmrc")).toBeLessThan(out.indexOf("COPY . ."));
  });

  it("omits --port so the container binds the platform-injected PORT", () => {
    const out = generateDockerfile({ port: 8123 });
    // Exec-form CMD keeps node as PID 1 for graceful SIGTERM; --host stays, --port is dropped.
    expect(out).toContain('"--host", "0.0.0.0"');
    expect(out).not.toContain('"--port"');
  });

  it("exposes and probes the port `skein start` falls back to when no PORT is injected", () => {
    // The CMD passes no --port, so with PORT unset the server binds `skein start`'s own default. That
    // default, the EXPOSE and the healthcheck's fallback must be the same number, or a bare
    // `docker run` (and any platform that makes you declare a port rather than injecting one — App
    // Runner, ECS, Kubernetes) binds one port while the image advertises and probes another.
    const out = generateDockerfile({ port: DEFAULT_CONTAINER_PORT });
    expect(out).toContain(`EXPOSE ${DEFAULT_CONTAINER_PORT}`);
    expect(out).toContain(`:${DEFAULT_CONTAINER_PORT};fetch(`);
  });

  it("generates a native Bun image and PID-1 launcher", () => {
    const out = generateDockerfile({
      runtime: "bun",
      runtimeVersion: "1.3.14",
      port: 8123,
    });
    expect(out).toContain("FROM oven/bun:1.3.14-slim");
    expect(out).toContain("bun install --production");
    expect(out).toContain("USER bun");
    expect(out).toContain('CMD ["bun", "/app/node_modules/skein-js/dist/index.js", "start"');
    expect(out).toContain('"--runtime", "bun"');
    expect(out).not.toContain('CMD ["node"');
  });

  it("generates a native permission-bounded Deno image and launcher", () => {
    const out = generateDockerfile({
      runtime: "deno",
      runtimeVersion: "2.9.4",
      port: 8123,
    });
    expect(out).toContain("FROM denoland/deno:2.9.4");
    expect(out).toContain("deno install --allow-scripts");
    expect(out).toContain("USER deno");
    expect(out).toContain('CMD ["deno", "run", "--allow-net", "--allow-env"');
    expect(out).toContain('"--allow-read=/app"');
    expect(out).toContain('"--runtime", "deno"');
  });

  it("keeps the Node CMD free of --runtime, so an image can boot a published CLI", () => {
    // The artifact pins `skein-js` to the CLI's published version. A flag that only exists in an
    // unreleased commit would kill every Node image built from it with `unknown option '--runtime'`.
    const out = generateDockerfile({ port: 8123 });
    expect(out).toContain('CMD ["node", "/app/node_modules/skein-js/dist/index.js", "start"');
    expect(out).not.toContain('"--runtime"');
    // Bun and Deno genuinely need selecting, so they still pass it.
    expect(generateDockerfile({ runtime: "bun", port: 8123 })).toContain('"--runtime", "bun"');
  });

  it("never uses a Node major as a Bun or Deno image tag", () => {
    // A config with both `node_version` and `skein.runtime.name` must not produce `oven/bun:24-slim`.
    expect(generateDockerfile({ runtime: "bun", nodeVersion: "24", port: 8123 })).toContain(
      "FROM oven/bun:1.3.14-slim",
    );
    expect(generateDockerfile({ runtime: "deno", nodeVersion: "24", port: 8123 })).toContain(
      "FROM denoland/deno:2.9.4",
    );
    // On Node it remains the fallback it was written to be.
    expect(generateDockerfile({ nodeVersion: "22", port: 8123 })).toContain("FROM node:22-slim");
  });

  it("passes no permission flags to `deno eval`", () => {
    // `deno eval` has implicit access to everything and *rejects* `--allow-*` with
    // `unexpected argument`. Both the build-time graph probe and the HEALTHCHECK use it, so a flag
    // here fails the image build and pins the container permanently unhealthy. Both reproduced.
    const out = generateDockerfile({ runtime: "deno", runtimeVersion: "2.9.4", port: 8123 });
    for (const line of out.split("\n").filter((l) => l.includes("deno eval"))) {
      expect(line).not.toMatch(/--allow-(net|env|read|sys|ffi|write|run)/);
    }
    // `deno run` — the CMD — is the opposite: it must carry the explicit grants.
    expect(out).toContain('CMD ["deno", "run", "--allow-net", "--allow-env"');
  });

  it("keeps Deno's home directory inside the granted read scope", () => {
    // Without this, `langsmith` (reached via `@langchain/core`, so every graph) throws `NotCapable`
    // reading `~/.langsmith/config.json` and every run fails. Reproduced on a real Deno server.
    const out = generateDockerfile({ runtime: "deno", runtimeVersion: "2.9.4", port: 8123 });
    expect(out).toContain("ENV HOME=/app");
    expect(out).toContain('"--allow-read=/app"');

    // Node and Bun have no read sandbox, so they must not carry the override.
    expect(generateDockerfile({ runtime: "node", port: 8123 })).not.toContain("ENV HOME=");
    expect(generateDockerfile({ runtime: "bun", port: 8123 })).not.toContain("ENV HOME=");
  });

  it("runs a selected-runtime graph compatibility probe during the image build", () => {
    const out = generateDockerfile({ runtime: "bun", runtimeVersion: "1.3.14", port: 8123 });
    expect(out).toContain("Import every graph under the selected runtime");
    expect(out).toContain("RUN bun --input-type=module -e");
    expect(out.indexOf("COPY . .")).toBeLessThan(out.indexOf("missing graph export"));
  });
});

describe("generateCompose", () => {
  it("wires app + pgvector Postgres + Redis with healthcheck-gated startup", () => {
    const out = generateCompose({ hostPort: 8123, host: "0.0.0.0", containerPort: 8123 });
    expect(out).toContain("image: pgvector/pgvector:pg16");
    expect(out).toContain("image: redis:7");
    expect(out).toContain("condition: service_healthy");
    expect(out).toContain("POSTGRES_URI: postgresql://postgres:postgres@postgres:5432/skein");
    expect(out).toContain("REDIS_URI: redis://redis:6379");
    // PORT is injected so the app binds the container port the mapping publishes; init reaps zombies.
    expect(out).toContain('PORT: "8123"');
    expect(out).toContain("init: true");
  });

  it("publishes on all interfaces by default and binds a specific host when given one", () => {
    expect(generateCompose({ hostPort: 9000, host: "0.0.0.0", containerPort: 8123 })).toContain(
      '- "9000:8123"',
    );
    expect(generateCompose({ hostPort: 9000, host: "127.0.0.1", containerPort: 8123 })).toContain(
      '- "127.0.0.1:9000:8123"',
    );
  });

  it("keeps a terse `build: .` and emits no secrets block without an npmrc", () => {
    const out = generateCompose({ hostPort: 8123, host: "0.0.0.0", containerPort: 8123 });
    expect(out).toContain("build: .");
    expect(out).not.toContain("secrets:");
  });

  it("wires the npmrc as a build secret when given one", () => {
    const out = generateCompose({
      hostPort: 8123,
      host: "0.0.0.0",
      containerPort: 8123,
      npmrcPath: "/home/me/.npmrc",
    });
    expect(out).not.toContain("build: .");
    expect(out).toContain("context: .");
    // The app build references the `npmrc` secret, defined at the top level pointing at the host file.
    expect(out).toMatch(/secrets:\s*\n\s*- npmrc/);
    // The path is emitted as a quoted YAML scalar so unusual paths can't corrupt the document.
    expect(out).toContain('npmrc:\n    file: "/home/me/.npmrc"');
  });
});

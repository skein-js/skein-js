import { describe, expect, it } from "vitest";

import { generateCompose } from "./compose.js";
import { generateDockerfile } from "./dockerfile.js";

describe("generateDockerfile", () => {
  it("pins the base image to the config's node_version and appends dockerfile_lines", () => {
    const out = generateDockerfile({
      nodeVersion: "22",
      dockerfileLines: ["RUN echo hello", "ENV FOO=bar"],
      port: 8123,
      packageManager: "npm",
    });
    expect(out).toContain("FROM node:22-slim");
    expect(out).toContain("RUN echo hello");
    expect(out).toContain("ENV FOO=bar");
    // The extra lines land before the CMD, not after it.
    expect(out.indexOf("RUN echo hello")).toBeLessThan(out.indexOf("CMD"));
  });

  it("defaults to node 20 and boots against postgres + redis with reload off", () => {
    const out = generateDockerfile({ port: 8123, packageManager: "npm" });
    expect(out).toContain("FROM node:20-slim");
    expect(out).toContain('"--store", "postgres"');
    expect(out).toContain('"--queue", "redis"');
    expect(out).toContain('"--no-reload"');
    expect(out).toContain("EXPOSE 8123");
  });

  it("uses the matching install command per package manager", () => {
    expect(generateDockerfile({ port: 8123, packageManager: "pnpm" })).toContain(
      "pnpm install --frozen-lockfile",
    );
    expect(generateDockerfile({ port: 8123, packageManager: "yarn" })).toContain(
      "yarn install --frozen-lockfile",
    );
    expect(generateDockerfile({ port: 8123, packageManager: "npm" })).toContain("npm ci");
  });
});

describe("generateCompose", () => {
  it("wires app + pgvector Postgres + Redis with healthcheck-gated startup", () => {
    const out = generateCompose({ hostPort: 8123, host: "0.0.0.0", containerPort: 8123 });
    expect(out).toContain("image: pgvector/pgvector:pg16");
    expect(out).toContain("image: redis:7");
    expect(out).toContain("condition: service_healthy");
    expect(out).toContain("DATABASE_URL: postgresql://postgres:postgres@postgres:5432/skein");
    expect(out).toContain("REDIS_URL: redis://redis:6379");
  });

  it("publishes on all interfaces by default and binds a specific host when given one", () => {
    expect(generateCompose({ hostPort: 9000, host: "0.0.0.0", containerPort: 8123 })).toContain(
      '- "9000:8123"',
    );
    expect(generateCompose({ hostPort: 9000, host: "127.0.0.1", containerPort: 8123 })).toContain(
      '- "127.0.0.1:9000:8123"',
    );
  });
});

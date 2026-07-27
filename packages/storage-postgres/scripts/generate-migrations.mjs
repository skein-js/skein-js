#!/usr/bin/env node
// Generate `src/migrations.generated.ts` — the migration SQL compiled into the JS bundle.
//
// Why this exists: the driver used to locate `migrations/` at runtime via
// `new URL("../migrations", import.meta.url)` and hand it to node-pg-migrate. Bundlers rewrite
// `import.meta.url` to the output location, so @skein-js/storage-postgres could not be bundled —
// it had to be externalized by every consumer that bundles a server (Next.js, webpack/rspack,
// esbuild). Compiling the SQL in removes the package's only filesystem access. See docs/bundling.md.
//
// The `.sql` files stay the authoring source of truth — they diff well and read as SQL. Run
// `nx run storage-postgres:generate-migrations` (or `pnpm migrations:generate`) after touching one;
// `src/migrations.test.ts` fails if the generated module drifts.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(packageRoot, "migrations");
const outputFile = path.join(packageRoot, "src", "migrations.generated.ts");

/**
 * node-pg-migrate's own section marker (`createMigrationCommentRegex`). Reproduced exactly so the
 * SQL we execute is byte-identical to what node-pg-migrate sent before 0.10.0 — that is what makes
 * an existing `skein_migrations` ledger safe to upgrade in place.
 */
const sectionMarker = (direction) => new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, "im");

/**
 * The up half of a migration file, sliced the way node-pg-migrate's `getActions` slices it: from the
 * `-- Up Migration` marker (inclusive) to the `-- Down Migration` marker (exclusive). The down half
 * is dropped — skein only ever migrates up, and dead SQL is worse than no SQL.
 */
function extractUpMigration(contents) {
  const upStart = contents.search(sectionMarker("up"));
  const downStart = contents.search(sectionMarker("down"));
  if (upStart < 0) return contents;
  return contents.slice(upStart, downStart < upStart ? undefined : downStart);
}

/** Escape SQL for embedding in an untagged template literal. */
function escapeTemplateLiteral(sql) {
  return sql.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Marks a migration whose statements must run outside a transaction, one at a time.
 *
 * `CREATE INDEX CONCURRENTLY` is rejected inside a transaction block, and `pg`'s simple query
 * protocol wraps a multi-statement string in an implicit one — so such a migration cannot go through
 * the normal BEGIN/COMMIT path and has to be pre-split.
 */
const CONCURRENT_MARKER = /^\s*--\s*skein:concurrent\s*$/im;

/**
 * Split a concurrent migration into single statements at build time rather than in the runner.
 *
 * Build time because a bad split should fail `pnpm migrations:generate`, where the author sees it,
 * not a production boot. The split is deliberately naive — one statement per `;` — so the checks
 * below reject anything it could get wrong: a dollar-quoted body (`DO $$ … $$`) or a literal
 * containing a semicolon. Concurrent migrations exist for index DDL; that is all they may contain.
 */
function splitConcurrentStatements(file, up) {
  const body = up
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  if (body.includes("$$")) {
    throw new Error(
      `${file} is marked skein:concurrent but contains a dollar-quoted body, which this splitter ` +
        `cannot parse. Concurrent migrations may only contain single-statement index DDL.`,
    );
  }
  if (body.includes("'")) {
    throw new Error(
      `${file} is marked skein:concurrent but contains a string literal, which could hide a ` +
        `semicolon from this splitter. Concurrent migrations may only contain index DDL.`,
    );
  }
  const statements = body
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  if (statements.length === 0) {
    throw new Error(`${file} is marked skein:concurrent but has no statements.`);
  }
  for (const statement of statements) {
    if (!/^(CREATE|DROP)\s+INDEX\b/i.test(statement)) {
      throw new Error(
        `${file} is marked skein:concurrent but has a non-index statement: ${statement.slice(0, 60)}…`,
      );
    }
  }
  return statements;
}

/** `0001_init` → `MIGRATION_0001_INIT`. */
function constantNameOf(migrationName) {
  return `MIGRATION_${migrationName.toUpperCase()}`;
}

const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
if (files.length === 0) throw new Error(`No .sql files found in ${migrationsDir}`);

const migrations = await Promise.all(
  files.map(async (file) => {
    const name = path.basename(file, ".sql");
    if (!/^\d{4}_[a-z0-9_]+$/.test(name)) {
      throw new Error(`Migration filename must look like 0001_snake_case.sql, got: ${file}`);
    }
    const contents = await readFile(path.join(migrationsDir, file), "utf8");
    const up = extractUpMigration(contents);
    if (up.trim() === "") throw new Error(`Migration ${file} has an empty up section`);
    const concurrent = CONCURRENT_MARKER.test(up);
    return { name, up, statements: concurrent ? splitConcurrentStatements(file, up) : undefined };
  }),
);

const source = `// GENERATED by scripts/generate-migrations.mjs — do not edit by hand.
// Source of truth: ../migrations/*.sql. Run \`pnpm migrations:generate\` after editing one.
//
// The SQL is compiled in rather than read off disk so this package bundles with zero externals
// (docs/bundling.md). \`name\` is the ledger key written to \`skein_migrations\` — it matches the
// filename stem node-pg-migrate used before 0.10.0, so existing databases upgrade in place.

/** One schema migration, applied in array order and recorded in \`skein_migrations\` by \`name\`. */
export interface SkeinMigration {
  /** Ledger key. Must never change for an already-released migration. */
  readonly name: string;
  /** The up SQL, executed as a single multi-statement query. */
  readonly up: string;
  /**
   * Present when the migration is marked \`-- skein:concurrent\`: \`up\` pre-split into single
   * statements, to be run one at a time *outside* any transaction.
   *
   * \`CREATE INDEX CONCURRENTLY\` is rejected inside a transaction block, and \`pg\`'s simple query
   * protocol wraps a multi-statement string in an implicit one — so these cannot go through the
   * normal BEGIN/COMMIT path. Split at generate time so a malformed one fails the build.
   */
  readonly statements?: readonly string[];
}

${migrations
  .map(({ name, up }) => `const ${constantNameOf(name)} = \`${escapeTemplateLiteral(up)}\`;`)
  .join("\n\n")}

/** Every migration, oldest first. Order is the contract — never reorder or rename. */
export const SKEIN_MIGRATIONS: readonly SkeinMigration[] = [
${migrations
  .map(({ name, statements }) => {
    const split = statements
      ? `, statements: [${statements.map((statement) => `\`${escapeTemplateLiteral(statement)}\``).join(", ")}]`
      : "";
    return `  { name: "${name}", up: ${constantNameOf(name)}${split} },`;
  })
  .join("\n")}
];
`;

const prettierConfig = await resolveConfig(outputFile);
await writeFile(
  outputFile,
  await format(source, { ...prettierConfig, parser: "typescript" }),
  "utf8",
);
console.log(
  `Wrote ${path.relative(packageRoot, outputFile)} from ${migrations.length} migrations.`,
);

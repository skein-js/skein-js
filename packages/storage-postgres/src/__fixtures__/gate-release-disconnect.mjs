import assert from "node:assert/strict";
import process from "node:process";

import { createPostgresPool, createPostgresThreadExecutionGate } from "../../dist/index.js";

const pool = createPostgresPool(process.env.POSTGRES_URI, { poolMax: 1 });
const method = process.argv[2];
const lease = await createPostgresThreadExecutionGate(pool)[method]("release-disconnect");
await lease.release();
assert.equal(lease.signal.aborted, true);
assert.equal(pool.totalCount, 0);
await pool.end();

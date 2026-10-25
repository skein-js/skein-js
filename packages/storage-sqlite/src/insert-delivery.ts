import { randomUUID } from "node:crypto";

import {
  serializeWireJson,
  type Delivery,
  type DeliveryCreate,
  type RunStatus,
} from "@skein-js/core";
import type { Database } from "better-sqlite3";

/** Used inside the caller's settlement/recovery transaction. */
export function insertDelivery(
  database: Database,
  runId: string,
  status: RunStatus,
  input: DeliveryCreate,
  claimed = true,
): Delivery {
  const at = new Date().toISOString();
  const delivery: Delivery = {
    delivery_id: input.delivery_id ?? randomUUID(),
    run_id: runId,
    thread_id: input.thread_id,
    url: input.url,
    payload: input.payload ?? null,
    payload_truncated: input.payload_truncated ?? false,
    run_status: status,
    status: claimed ? "delivering" : "pending",
    attempt: claimed ? 1 : 0,
    next_attempt_at: input.next_attempt_at,
    last_error: null,
    created_at: at,
    updated_at: at,
    expires_at: input.expires_at,
  };
  database
    .prepare("INSERT INTO skein_deliveries(key,body) VALUES (?,?)")
    .run(delivery.delivery_id, serializeWireJson(delivery));
  return JSON.parse(serializeWireJson(delivery)) as Delivery;
}

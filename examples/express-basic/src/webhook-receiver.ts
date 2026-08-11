// A receiver for skein's run-completion callbacks, written the way one should be written.
//
// Run it (`node --experimental-strip-types src/webhook-receiver.ts`), point a run at it, and it will
// print what it accepted and what it refused. It exists because "verify the signature" is easy to
// agree with and easy to get wrong: the three mistakes below are the ones that actually happen, and
// each is a comment rather than a footnote.
//
//   SKEIN_WEBHOOK_SECRET=whsec_dev node --experimental-strip-types src/webhook-receiver.ts
//   # then, with the same secret set for the server:
//   curl -X POST localhost:2024/threads/$TID/runs \
//     -d '{"assistant_id":"echo","input":{},"webhook":"http://localhost:4000/hooks/skein"}'

import { createServer } from "node:http";

import { verifySkeinSignature } from "@skein-js/agent-protocol";

const PORT = Number(process.env["PORT"] ?? 4000);

/**
 * Every key this receiver accepts.
 *
 * A **list**, so a rotation does not drop callbacks: while both keys are live, add both here, wait
 * for the sender to finish rotating, then remove the old one. Removing it first refuses every
 * callback until every sender has caught up.
 */
const SECRETS = (process.env["SKEIN_WEBHOOK_SECRET"] ?? "")
  .split(",")
  .map((secret) => secret.trim())
  .filter(Boolean);

// Refuse to start rather than fall back to a literal. A default like `"whsec_dev"` would be a key
// published in this repository, so a copy of this file that lost its env var would keep *appearing*
// to verify while accepting anything an attacker signs with a value they can read on GitHub — a
// fail-open with no signal. `verifySkeinSignature` fails closed on an empty list, and this makes
// sure that is what an unset variable actually produces. `resolveWebhookSecrets` on the sending side
// takes the same position.
if (SECRETS.length === 0) {
  console.error("set SKEIN_WEBHOOK_SECRET to the same value the skein server signs with");
  process.exit(1);
}

/**
 * Delivery ids already processed.
 *
 * **This is not optional.** Delivery is at-least-once: a POST that timed out *after* this receiver
 * committed its work is indistinguishable, from the sender's side, from one that never arrived — so
 * it is retried, and this receiver sees it twice. `X-Skein-Delivery-Id` is stable across every
 * retry, which is what makes the second one a no-op instead of a duplicate charge, a duplicate
 * email, or a duplicate downstream run.
 *
 * A `Set` because this is an example. In production this belongs wherever your work is committed —
 * ideally a unique constraint in the same transaction, so dedup and work commit together.
 */
const processed = new Set<string>();

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.startsWith("/hooks/skein")) {
    response.writeHead(404).end();
    return;
  }

  // The **raw bytes**, collected before anything parses them. `JSON.stringify(req.body)` will not do:
  // key order, spacing and number formatting are not guaranteed to round-trip, so a re-serialized
  // body hashes differently and every genuine callback fails. This is the single most common way a
  // working integration looks broken. With Express: `express.raw({ type: "application/json" })`.
  //
  // Buffers are collected and decoded **once**, at the end. Decoding each chunk separately looks
  // identical and is wrong: a multi-byte UTF-8 sequence split across a chunk boundary decodes to
  // U+FFFD on both sides, so the body no longer matches what was signed and every callback carrying a
  // non-ASCII character fails verification. It is the same class of bug as re-serializing, and just as
  // hard to see, because it only bites on some payloads.
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const verified = verifySkeinSignature({
      header: request.headers["x-skein-signature"] as string | undefined,
      body: raw,
      secrets: SECRETS,
    });
    if (!verified.ok) {
      // 401, and nothing else happens. A forged callback and a replayed one both land here: the
      // signature covers the timestamp, so a captured callback stops verifying once it is outside
      // the tolerance window, with no state needed on this side to notice.
      console.warn(`refused a callback (${verified.reason}): ${verified.message}`);
      response.writeHead(401).end();
      return;
    }

    const deliveryId = request.headers["x-skein-delivery-id"] as string | undefined;
    const attempt = request.headers["x-skein-attempt"] as string | undefined;
    if (deliveryId && processed.has(deliveryId)) {
      // Already done. Answer 200 — a non-2xx would make the sender retry a callback this receiver
      // has, in fact, fully handled.
      console.log(`duplicate delivery ${deliveryId} (attempt ${attempt}) — already processed`);
      response.writeHead(200).end();
      return;
    }

    const body = JSON.parse(raw) as { run_id: string; status: string; values?: unknown };
    if (deliveryId) processed.add(deliveryId);
    console.log(`run ${body.run_id} finished with status ${body.status} (attempt ${attempt})`);

    // 2xx *only* once the work is durably done. Answering early and then failing loses the callback:
    // the sender heard success and will not retry. Answering non-2xx is how you ask for a retry.
    response.writeHead(200).end();
  });
});

server.listen(PORT, () => {
  console.log(`skein webhook receiver on http://localhost:${PORT}/hooks/skein`);
  console.log(`accepting ${SECRETS.length} signing key(s)`);
});

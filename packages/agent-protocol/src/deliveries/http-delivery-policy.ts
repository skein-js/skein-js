import type { DeliveryAttempt } from "../deps.js";

import type { WebhookDeliveryConfig } from "./delivery-config.js";
import { isServerDerivedTarget } from "./delivery-target.js";

const REFUSE_REDIRECTS = Symbol("refuse-webhook-redirects");

export function refusesWebhookRedirects(attempt: DeliveryAttempt | undefined): boolean {
  return attempt !== undefined && REFUSE_REDIRECTS in attempt;
}

/** Preserve the signature's bytes and authoritative headers, including differently cased names. */
export function configureHttpDelivery(
  attempt: DeliveryAttempt,
  target: string,
  webhooks: WebhookDeliveryConfig | undefined,
): DeliveryAttempt {
  if (isServerDerivedTarget(target)) return attempt;
  const headers = Object.fromEntries(
    Object.entries(webhooks?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const name of [
    "content-type",
    "content-length",
    "host",
    "transfer-encoding",
    "x-skein-delivery-id",
    "x-skein-attempt",
    "x-skein-signature",
  ])
    delete headers[name];
  const policy = webhooks?.url;
  const restrictsDestination =
    policy &&
    (webhooks?.requireHttps === true ||
      policy.allowedDomains !== undefined ||
      policy.allowedPorts !== undefined ||
      policy.disableLoopback === true ||
      policy.maxUrlLength !== undefined);
  return {
    ...attempt,
    headers: { ...headers, ...attempt.headers },
    ...(restrictsDestination ? { [REFUSE_REDIRECTS]: true } : {}),
  };
}

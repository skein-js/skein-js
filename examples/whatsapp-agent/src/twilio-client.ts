// The one seam every outbound call goes through.
//
// It exists so the tests can assert on what *would* have been sent without a Twilio account, a
// network, or a live phone number — and so this example is green in CI like every other one. It is
// not part of the inbound plumbing being measured; it is the provider SDK we deliberately do not
// depend on, reduced to the two calls this example makes.

/** A message to send back to the customer. */
export interface OutboundMessage {
  /** Full channel address, e.g. `whatsapp:+254712345678`. */
  to: string;
  body: string;
}

export interface TwilioClient {
  sendMessage(message: OutboundMessage): Promise<void>;
  /**
   * Show the typing indicator.
   *
   * Keyed on the **inbound** message's SID, not on the conversation: Twilio renders the indicator
   * against the message it is a reply to, and marks that message read as a side effect. It expires
   * on its own after ~25 seconds and is cleared automatically when the reply is delivered, so there
   * is no matching "stop" call — see `typing-indicator.ts`.
   */
  showTyping(inboundMessageSid: string): Promise<void>;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** The number messages are sent from, e.g. `whatsapp:+14155238886`. */
  from: string;
  /**
   * Endpoint for the typing indicator, from
   * https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource — `{MessageSid}` is
   * substituted.
   *
   * Configuration rather than a constant baked in here, and **optional**, because the resource is
   * public beta: it carries no SLA and its path may still move. Leave it unset and the agent still
   * answers — it just answers without the indicator, which is the correct way for a best-effort
   * nicety to degrade.
   */
  typingIndicatorUrl?: string;
}

const MESSAGES_ENDPOINT = "https://api.twilio.com/2010-04-01/Accounts";

/** The real client. Raw HTTP against the documented API — no vendor SDK, by design. */
export function createTwilioClient(credentials: TwilioCredentials): TwilioClient {
  const authorization = `Basic ${Buffer.from(
    `${credentials.accountSid}:${credentials.authToken}`,
  ).toString("base64")}`;

  async function post(url: string, form: Record<string, string>): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) {
      throw new Error(`twilio ${response.status}: ${await response.text()}`);
    }
  }

  return {
    async sendMessage(message) {
      await post(`${MESSAGES_ENDPOINT}/${credentials.accountSid}/Messages.json`, {
        From: credentials.from,
        To: message.to,
        Body: message.body,
      });
    },
    async showTyping(inboundMessageSid) {
      const url = credentials.typingIndicatorUrl;
      if (url === undefined) return;
      await post(url.replace("{MessageSid}", encodeURIComponent(inboundMessageSid)), {
        MessageSid: inboundMessageSid,
      });
    },
  };
}

/** What a fake recorded. Exported so tests can assert on the sequence, not just the last call. */
export interface RecordedCall {
  kind: "message" | "typing";
  to?: string;
  body?: string;
  inboundMessageSid?: string;
}

export interface RecordingTwilioClient extends TwilioClient {
  readonly calls: readonly RecordedCall[];
}

export interface RecordingOptions {
  /**
   * Also print each call.
   *
   * On by default when the example runs standalone and off in tests: watching the round trip happen
   * is the whole point of running it with no credentials, and a test asserting on `calls` does not
   * want the noise.
   */
  log?: boolean;
}

/** A client that records instead of sending. The example's default when no credentials are set. */
export function createRecordingTwilioClient(options: RecordingOptions = {}): RecordingTwilioClient {
  const calls: RecordedCall[] = [];
  const log = options.log ?? false;
  return {
    calls,
    async sendMessage(message) {
      calls.push({ kind: "message", to: message.to, body: message.body });
      if (log) console.log(`→ whatsapp ${message.to}: ${message.body}`);
      return Promise.resolve();
    },
    async showTyping(inboundMessageSid) {
      calls.push({ kind: "typing", inboundMessageSid });
      if (log) console.log(`⋯ typing (in reply to ${inboundMessageSid})`);
      return Promise.resolve();
    },
  };
}

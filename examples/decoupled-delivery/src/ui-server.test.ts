import { afterEach, describe, expect, it } from "vitest";

import { startDemoUi, type DemoUiHandle } from "./ui-server.js";

let demoUi: DemoUiHandle | undefined;

afterEach(async () => {
  await demoUi?.stop();
  demoUi = undefined;
});

async function until<T>(read: () => Promise<T>, complete: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (complete(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the UI workflow.");
}

describe("decoupled delivery UI", () => {
  it("serves the playground and routes an email to WhatsApp", async () => {
    demoUi = await startDemoUi({ port: 0 });

    const page = await fetch(demoUi.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Send it in one way");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");

    const accepted = await fetch(`${demoUi.url}/api/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "ui-smoke-email",
        conversationId: "ui-smoke",
        from: "customer@example.com",
        subject: "Important order update",
        body: "The delivery address changed.",
        whatsappNumber: "whatsapp:+254700000001",
        priority: "high",
        requiresApproval: false,
      }),
    });
    expect(accepted.status).toBe(202);

    const state = await until(
      async () => {
        const response = await fetch(`${demoUi!.url}/api/state?conversationId=ui-smoke`);
        return (await response.json()) as {
          deliveries: Array<{ destination: string; target: { to: string } }>;
        };
      },
      (current) => current.deliveries.length === 1,
    );
    expect(state.deliveries).toEqual([
      expect.objectContaining({
        destination: "whatsapp",
        target: { to: "whatsapp:+254700000001" },
      }),
    ]);
  });
});

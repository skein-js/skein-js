export const app = {
  message: "built application",
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/custom") return new Response(null, { status: 404 });
    return new Response(`${this.message}: ${await request.text()}`, {
      headers: { "content-type": "text/plain" },
    });
  },
};

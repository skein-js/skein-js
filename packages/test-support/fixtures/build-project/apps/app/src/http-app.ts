export const app = {
  fetch(request: Request): Response {
    return new URL(request.url).pathname === "/custom-app"
      ? new Response("compiled custom app")
      : new Response(null, { status: 404 });
  },
};

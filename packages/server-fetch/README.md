# @skein-js/fetch

Native Web `Request`/`Response` transport for Skein. It is the production HTTP boundary for Bun and
Deno; Node framework adapters remain in `@skein-js/express`, `@skein-js/fastify`,
`@skein-js/nestjs`, and `@skein-js/nextjs`.

```ts
import { createSkeinFetchServer, startBunServer } from "@skein-js/fetch";

const skein = await createSkeinFetchServer({ config: "./langgraph.json", warm: true });
const listener = startBunServer(skein.fetch, { hostname: "0.0.0.0", port: 8000 });

// During shutdown: stop accepting traffic first, then drain the Skein worker.
listener.stop();
await skein.close();
```

`startDenoServer` provides the corresponding `Deno.serve()` launcher. The host must grant the
network, environment, filesystem, and npm-package permissions required by its graph.

## Building

Run `nx build server-fetch` to build the library.

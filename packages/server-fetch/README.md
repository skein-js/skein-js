# @skein-js/fetch

[![npm](https://img.shields.io/npm/v/%40skein-js%2Ffetch?logo=npm&color=cb3837)](https://www.npmjs.com/package/@skein-js/fetch)&nbsp;[![downloads](https://img.shields.io/npm/dm/%40skein-js%2Ffetch?color=blue)](https://www.npmjs.com/package/@skein-js/fetch)&nbsp;[![license](https://img.shields.io/npm/l/%40skein-js%2Ffetch?color=green)](../../LICENSE)

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

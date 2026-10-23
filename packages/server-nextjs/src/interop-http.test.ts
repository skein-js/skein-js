import { runInteropHttpConformance } from "@skein-js/test-support";
import { startEchoServer } from "./__fixtures__/echo-server.js";
for (const router of ["app", "pages"] as const)
  runInteropHttpConformance(`Next.js ${router}`, (options) =>
    startEchoServer({ ...options, router }),
  );

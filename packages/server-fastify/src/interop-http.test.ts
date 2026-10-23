import { runInteropHttpConformance } from "@skein-js/test-support";
import { startEchoServer } from "./__fixtures__/echo-server.js";
runInteropHttpConformance("fastify", startEchoServer);

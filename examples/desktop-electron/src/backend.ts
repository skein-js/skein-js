import { startWorkflowServer } from "@skein-js/example-local-workflow";
const directory = process.env["SKEIN_EXAMPLE_DATA"];
const token = process.env["SKEIN_EXAMPLE_TOKEN"];
if (!directory || !token || !process.parentPort)
  throw new Error("Launch through the Electron host.");
const server = await startWorkflowServer(directory, token, {
  fixture: process.env["SKEIN_EXAMPLE_SMOKE"] === "1",
});
process.parentPort.postMessage({ url: server.url });
process.parentPort.on("message", () => {
  void server.dispose().then(() => process.exit(0));
});

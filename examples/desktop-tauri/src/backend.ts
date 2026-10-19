import { startWorkflowServer, smokeReadingWorkflow } from "@skein-js/example-local-workflow";
const directory = process.env["SKEIN_EXAMPLE_DATA"];
const token = process.env["SKEIN_EXAMPLE_TOKEN"];
if (!directory || !token) throw new Error("Launch through the Tauri host.");
const server = await startWorkflowServer(directory, token, {
  fixture: process.env["SKEIN_EXAMPLE_SMOKE"] === "1",
  application: "reading",
});
console.log(JSON.stringify({ url: server.url }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.dispose();
  process.exit(0);
}
// Any line, or the pipe closing, means the host is gone or quitting. A crashed or force-killed host
// only closes stdin, and a sidecar left running would keep the SQLite file locked for the next launch.
process.stdin.on("data", () => {
  void stop();
});
process.stdin.on("end", () => {
  void stop();
});
process.stdin.resume();
process.once("SIGTERM", () => {
  void stop();
});
if (process.env["SKEIN_EXAMPLE_SMOKE"] === "1") {
  try {
    await smokeReadingWorkflow(server.url, token);
    console.log("PACKAGED_TAURI_OK");
    await stop();
  } catch (error) {
    console.error(error);
    await server.dispose();
    process.exit(1);
  }
}

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
app.setName("Daybook");

if (process.platform === "darwin" && process.env["SKEIN_EXAMPLE_SMOKE"] === "1")
  app.setActivationPolicy("prohibited");

async function startDesktop(): Promise<void> {
  const { smokeWorkflow } = await import("@skein-js/example-local-workflow");
  await app.whenReady();
  const smoke = process.env["SKEIN_EXAMPLE_SMOKE"] === "1";
  const directory = smoke
    ? join(app.getPath("userData"), "smoke", randomBytes(8).toString("hex"))
    : app.getPath("userData");
  const token = randomBytes(32).toString("hex");
  const output = dirname(fileURLToPath(import.meta.url));
  const backend = utilityProcess.fork(join(output, "backend.js"), [], {
    serviceName: "Skein local workflow",
    allowLoadingUnsignedLibraries: true,
    env: { ...process.env, SKEIN_EXAMPLE_DATA: directory, SKEIN_EXAMPLE_TOKEN: token },
  });
  const connection = await new Promise<{ url: string; token: string }>((resolve, reject) => {
    backend.once("message", (message: { url: string }) => resolve({ ...message, token }));
    backend.once("exit", (code) => reject(new Error(`Backend exited before startup (${code})`)));
  });
  if (smoke) {
    let code = 0;
    try {
      await smokeWorkflow(connection.url, token);
      console.log("PACKAGED_ELECTRON_OK");
    } catch (error) {
      console.error(error);
      code = 1;
    }
    const stopped = new Promise((resolve) => backend.once("exit", resolve));
    backend.postMessage("shutdown");
    await stopped;
    await rm(directory, { recursive: true, force: true });
    app.exit(code);
  } else {
    const window = new BrowserWindow({
      title: "Daybook",
      width: 1240,
      height: 900,
      minWidth: 760,
      minHeight: 600,
      backgroundColor: "#f6f5f1",
      webPreferences: {
        preload: join(output, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    ipcMain.handle("connection", (event) => {
      if (event.sender !== window.webContents) throw new Error("Unknown renderer");
      return connection;
    });
    await window.loadFile(join(output, "index.html"));
    let stopping = false;
    app.on("before-quit", (event) => {
      if (stopping) return;
      event.preventDefault();
      stopping = true;
      backend.once("exit", () => app.quit());
      backend.postMessage("shutdown");
      setTimeout(() => {
        backend.kill();
        app.exit();
      }, 5000).unref();
    });
    app.on("window-all-closed", () => app.quit());
  }
}

// Let Electron finish evaluating the ESM entry before its ready event can fire.
void startDesktop().catch((error) => {
  console.error(error);
  app.exit(1);
});

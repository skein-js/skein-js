import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("skeinConnection", () => ipcRenderer.invoke("connection"));

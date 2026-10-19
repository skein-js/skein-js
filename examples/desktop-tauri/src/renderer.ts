import { mountWorkflowUi } from "@skein-js/example-local-workflow/ui";
import { invoke } from "@tauri-apps/api/core";
await mountWorkflowUi(await invoke<{ url: string; token: string }>("connection"), "reading");

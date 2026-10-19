import { mountWorkflowUi } from "@skein-js/example-local-workflow/ui";
const host = window as unknown as { skeinConnection(): Promise<{ url: string; token: string }> };
await mountWorkflowUi(await host.skeinConnection());

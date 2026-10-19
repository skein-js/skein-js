import {
  modelProviders,
  usesApiKey,
  type ModelConnection,
  type ModelProvider,
} from "./model-preferences.js";

export function mountModelSettings(
  connection: { url: string; token: string },
  onChange: (status: ModelConnection) => void,
) {
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
  const provider = document.querySelector<HTMLSelectElement>("#model-provider")!;
  const project = document.querySelector<HTMLInputElement>("#cloud-project")!;
  const location = document.querySelector<HTMLInputElement>("#cloud-location")!;
  const baseUrl = document.querySelector<HTMLInputElement>("#ollama-url")!;
  const key = document.querySelector<HTMLInputElement>("#model-api-key")!;
  const model = document.querySelector<HTMLInputElement>("#model-name")!;
  const error = document.querySelector<HTMLElement>("#model-error")!;
  const models: Partial<Record<ModelProvider, string>> = {};
  let activeProvider: ModelProvider = "vertex";
  let status: ModelConnection = {
    configured: false,
    provider: "vertex",
    providerLabel: "Vertex AI",
    project: "",
    location: "global",
    model: modelProviders.vertex.model,
    credentialsAvailable: { gemini: false, openai: false, anthropic: false },
    baseUrl: "http://127.0.0.1:11434",
  };
  function selectProvider() {
    error.textContent = "";
    const selected = provider.value as ModelProvider;
    models[activeProvider] = model.value;
    activeProvider = selected;
    model.value =
      models[selected] ??
      (selected === status.provider ? status.model : modelProviders[selected].model);
    document.querySelector<HTMLElement>("#vertex-settings")!.hidden = selected !== "vertex";
    document.querySelector<HTMLElement>("#api-key-settings")!.hidden = !usesApiKey(selected);
    document.querySelector<HTMLElement>("#ollama-settings")!.hidden = selected !== "ollama";
    baseUrl.required = selected === "ollama";
    document.querySelector<HTMLButtonElement>("#disconnect-model")!.hidden =
      selected !== status.provider || !status.configured;
    project.required = selected === "vertex";
    location.required = selected === "vertex";
    key.value = "";
    const available = usesApiKey(selected) && status.credentialsAvailable[selected];
    key.required = usesApiKey(selected) && !available;
    key.placeholder = available
      ? "Available in this session · leave blank to keep it"
      : `Enter your ${modelProviders[selected].label} API key`;
    document.querySelector<HTMLElement>("#model-privacy")!.textContent =
      selected === "ollama"
        ? "Requests go to the configured Ollama server. No cloud API key is sent. Install a model that supports tools."
        : `Source material and tool context you send are processed by ${modelProviders[selected].label}. API keys entered here stay in backend memory until the app closes.`;
  }
  async function request(method = "GET", body?: unknown): Promise<ModelConnection> {
    const response = await fetch(`${connection.url}/app/model`, {
      method,
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? "The model provider could not connect.");
    status = value;
    onChange(status);
    return status;
  }
  provider.onchange = selectProvider;
  document.querySelector<HTMLFormElement>("#model-form")!.onsubmit = (event) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>("#connect-model")!;
    button.disabled = true;
    button.textContent = "Checking connection…";
    error.textContent = "";
    void request("POST", {
      provider: provider.value,
      baseUrl: baseUrl.value.trim() || "http://127.0.0.1:11434",
      project: project.value.trim(),
      location: location.value.trim() || "global",
      model: model.value.trim(),
      ...(key.value.trim() ? { apiKey: key.value.trim() } : {}),
    })
      .then(() => dialog.close())
      .catch((failure: Error) => {
        error.textContent = failure.message;
      })
      .finally(() => {
        button.disabled = false;
        button.textContent = "Save & test connection";
      });
  };
  document.querySelector<HTMLButtonElement>("#disconnect-model")!.onclick = () => {
    void request("DELETE")
      .then(() => dialog.close())
      .catch((failure: Error) => {
        error.textContent = failure.message;
      });
  };
  dialog.addEventListener("close", () => {
    key.value = "";
  });
  return {
    refresh: () => request(),
    open() {
      baseUrl.value = status.baseUrl;
      project.value = status.project;
      location.value = status.location;
      model.value = status.model;
      models[status.provider] = status.model;
      activeProvider = status.provider;
      provider.value = status.provider;
      selectProvider();
      error.textContent = "";
      dialog.showModal();
    },
    ready() {
      return status.configured || Boolean(status.fixture);
    },
  };
}

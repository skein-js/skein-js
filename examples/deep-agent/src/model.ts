/** A LangChain provider:model string. The example includes Gemini by default. */
export function selectModel(role: "assistant" | "researcher"): string {
  const model = process.env["DEEP_AGENT_MODEL"]?.trim() || "google-genai:gemini-3.5-flash-lite";
  if (/^google(?:-genai)?:/.test(model) && !process.env["GOOGLE_API_KEY"]?.trim())
    throw new Error(`Set GOOGLE_API_KEY in the server environment or .env to run the ${role}.`);
  return model.replace(/^google:/, "google-genai:");
}

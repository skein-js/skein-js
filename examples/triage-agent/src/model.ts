import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function requireGoogleApiKey(): string {
  const key = process.env["GOOGLE_API_KEY"]?.trim();
  if (!key) throw new Error("Set GOOGLE_API_KEY in the server environment or .env to use Gemini.");
  return key;
}

export function createTriageModel() {
  return new ChatGoogleGenerativeAI({
    apiKey: requireGoogleApiKey(),
    model: process.env["GOOGLE_MODEL"]?.trim() || "gemini-3.5-flash-lite",
    temperature: 0,
  });
}

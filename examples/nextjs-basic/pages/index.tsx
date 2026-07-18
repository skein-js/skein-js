// A tiny landing page. The point of this example is the headless API route at
// `pages/api/[...path].ts` — this page just tells you how to talk to it.

export default function Home() {
  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1rem",
        lineHeight: 1.6,
      }}
    >
      <h1>skein-js · Next.js Pages Router</h1>
      <p>
        The Agent Protocol is served from a single catch-all route:{" "}
        <code>pages/api/[...path].ts</code>. Point a client at <code>/api</code>:
      </p>
      <pre
        style={{
          background: "#f4f4f5",
          padding: "1rem",
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        {`import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024/api" });
const thread = await client.threads.create();
const reply = await client.runs.wait(thread.thread_id, "echo", {
  input: { messages: [{ role: "user", content: "hello" }] },
});`}
      </pre>
      <p>
        Graphs: <code>echo</code> (zero-setup) and <code>agent</code> (needs{" "}
        <code>GOOGLE_API_KEY</code>).
      </p>
    </main>
  );
}

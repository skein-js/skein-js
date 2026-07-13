import type { ReactNode } from "react";

export const metadata = {
  title: "Skein · useStream harness",
  description: "Streams from a Skein server via @langchain/langgraph-sdk/react useStream.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          margin: 0,
          background: "#0b0b0f",
          color: "#e7e7ea",
        }}
      >
        {children}
      </body>
    </html>
  );
}

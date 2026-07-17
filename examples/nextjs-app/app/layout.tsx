import type { ReactNode } from "react";

export const metadata = {
  title: "skein-js · Next.js app",
  description:
    "The Agent Protocol served same-origin from a Next.js App Router route, with a useStream chat UI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
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

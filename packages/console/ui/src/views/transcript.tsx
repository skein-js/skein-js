import type { Message } from "@langchain/langgraph-sdk";
import { memo } from "react";
import Markdown from "react-markdown";

import { cn } from "@/lib/utils";

import { Json } from "./parts";

export const Transcript = memo(function Transcript({ messages }: { messages: readonly Message[] }) {
  return (
    <ol className="mx-auto w-full max-w-3xl space-y-6">
      {messages.map((message, index) => (
        <MessageRow key={message.id ?? index} message={message} />
      ))}
    </ol>
  );
});

const MessageRow = memo(function MessageRow({ message }: { message: Message }) {
  const shape = message as Message & {
    role?: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: { id?: string; name: string; args: unknown }[];
  };
  const role: string =
    (message as { type?: string; role?: string }).type ?? shape.role ?? "unknown";
  const human = role === "human" || role === "user";
  const tool = role === "tool";
  return (
    <li className={cn("flex min-w-0", human ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-full",
          human ? "max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-3" : "w-full",
        )}
      >
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          {human
            ? "You"
            : tool
              ? `Tool result · ${shape.name ?? shape.tool_call_id ?? "tool"}`
              : role === "ai" || role === "assistant"
                ? "Assistant"
                : role}
        </p>
        <MessageContent content={message.content} />
        {shape.tool_calls?.map((call, callIndex) => (
          <details key={call.id ?? callIndex} className="mt-3 rounded-lg border bg-muted/50 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Tool requested · {call.name}
            </summary>
            <div className="mt-2">
              <Json value={call.args} />
            </div>
          </details>
        ))}
      </div>
    </li>
  );
});

function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        components={{
          img: ({ src, alt }) => (
            <a href={src} target="_blank" rel="noreferrer">
              Open image: {alt || "attachment"}
            </a>
          ),
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

function MessageContent({ content }: { content: Message["content"] }) {
  if (typeof content === "string") return <MarkdownContent>{content}</MarkdownContent>;
  if (!Array.isArray(content)) return <Json value={content} />;
  return (
    <div className="space-y-2">
      {content.map((block, index) => {
        if (typeof block === "string")
          return <MarkdownContent key={index}>{block}</MarkdownContent>;
        if (block.type === "text" && typeof block.text === "string")
          return <MarkdownContent key={index}>{block.text}</MarkdownContent>;
        return (
          <details key={index}>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {String(block.type ?? "Content")} details
            </summary>
            <Json value={block} />
          </details>
        );
      })}
    </div>
  );
}

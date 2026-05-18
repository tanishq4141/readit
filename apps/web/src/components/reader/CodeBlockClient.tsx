"use client";

import { useEffect, useState } from "react";
import { highlightCode } from "@/lib/shiki";
import { MermaidDiagram } from "./MermaidDiagram";

interface CodeBlockClientProps {
  className?: string;
  children?: React.ReactNode;
}

export function CodeBlockClient({ className, children }: CodeBlockClientProps) {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!className || lang === "mermaid") return;
    let cancelled = false;
    highlightCode(text, lang ?? "text").then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [className, lang, text]);

  if (lang === "mermaid") {
    return <MermaidDiagram chart={text} />;
  }

  if (className) {
    if (!html) {
      return (
        <pre className="my-6 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
          …
        </pre>
      );
    }
    return (
      <div
        className="reader-code my-6 overflow-x-auto rounded-xl border border-zinc-800 text-sm [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-4"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <code className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[0.9em] text-amber-100/90">
      {children}
    </code>
  );
}

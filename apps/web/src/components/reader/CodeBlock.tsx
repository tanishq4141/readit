import { highlightCode } from "@/lib/shiki";
import { MermaidDiagram } from "./MermaidDiagram";

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
}

export async function CodeBlock({ className, children }: CodeBlockProps) {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];

  if (lang === "mermaid") {
    return <MermaidDiagram chart={text} />;
  }

  if (className) {
    const html = await highlightCode(text, lang ?? "text");
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

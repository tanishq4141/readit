"use client";

import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";

let mermaidInitialized = false;

interface MermaidDiagramProps {
  chart: string;
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mermaidInitialized) {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "loose",
        fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
      });
      mermaidInitialized = true;
    }

    let cancelled = false;

    (async () => {
      try {
        const { svg: rendered } = await mermaid.render(
          `mermaid-${id}`,
          chart.trim(),
        );
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Diagram failed to render");
          setSvg(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <pre className="my-6 overflow-x-auto rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
        {error}
        {"\n\n"}
        {chart}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="my-6 flex h-32 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/50 text-sm text-zinc-500">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="reader-mermaid my-8 flex justify-center overflow-x-auto rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-6"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

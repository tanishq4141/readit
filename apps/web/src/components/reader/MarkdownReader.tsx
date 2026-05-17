import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface MarkdownReaderProps {
  content: string;
}

export async function MarkdownReader({ content }: MarkdownReaderProps) {
  return (
    <article className="reader-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-6 font-serif text-3xl font-semibold tracking-tight text-zinc-50 md:text-4xl">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-12 mb-4 font-serif text-2xl font-semibold text-zinc-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-8 mb-3 text-xl font-semibold text-zinc-200">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-5 text-[1.05rem] leading-[1.85] text-zinc-300">
              {children}
            </p>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-8 border-l-2 border-violet-500/60 pl-5 text-zinc-400 italic">
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-300">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-6 list-decimal space-y-2 pl-6 text-zinc-300">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-[1.75] text-zinc-300">{children}</li>
          ),
          hr: () => <hr className="my-10 border-zinc-800" />,
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-8 overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-zinc-900/80 text-left text-zinc-200">
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="border-b border-zinc-800 px-4 py-3 font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-zinc-800/60 px-4 py-3 text-zinc-400">
              {children}
            </td>
          ),
          pre: ({ children }) => <>{children}</>,
          code: CodeBlock,
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

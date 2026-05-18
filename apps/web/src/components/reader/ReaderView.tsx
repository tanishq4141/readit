"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { MarkdownReaderClient } from "@/components/reader/MarkdownReaderClient";
import {
  formatChapterTitle,
  getAdjacentChapters,
  getBookIndex,
  getChapterMarkdown,
  readerHref,
} from "@/lib/books";
import type { BookIndex } from "@/lib/types";

interface ReaderViewProps {
  slug: string;
}

function ReaderViewInner({ slug }: ReaderViewProps) {
  const searchParams = useSearchParams();
  const chapterId = searchParams.get("chapter") ?? "intro";

  const [index, setIndex] = useState<BookIndex | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setContent(null);

    (async () => {
      try {
        const bookIndex = await getBookIndex(slug);
        if (cancelled) return;
        if (!bookIndex) {
          setError("Book not found");
          return;
        }
        setIndex(bookIndex);

        const chapter = await getChapterMarkdown(slug, chapterId);
        if (cancelled) return;
        if (!chapter) {
          setError("Chapter not found");
          return;
        }
        setContent(chapter.content);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load chapter");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, chapterId]);

  if (error) {
    return (
      <div className="min-h-screen bg-[#0c0c0f] text-zinc-100">
        <SiteHeader showBack backHref={`/books/${slug}`} backLabel="Book" />
        <main className="mx-auto max-w-3xl px-4 py-10 text-amber-400/90">
          {error}
        </main>
      </div>
    );
  }

  if (!index || content === null) {
    return (
      <div className="min-h-screen bg-[#0c0c0f] text-zinc-100">
        <SiteHeader showBack backHref={`/books/${slug}`} backLabel="Book" />
        <main className="mx-auto max-w-3xl px-4 py-10 text-zinc-500">
          Loading…
        </main>
      </div>
    );
  }

  const { prev, next } = getAdjacentChapters(index, chapterId);

  return (
    <div className="min-h-screen bg-[#0c0c0f] text-zinc-100">
      <SiteHeader
        showBack
        backHref={`/books/${slug}`}
        backLabel={index.meta.title}
      />
      <div className="mx-auto flex max-w-6xl">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-800/60 lg:block">
          <nav className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto p-4 text-sm">
            <Link
              href={readerHref(slug, index.intro.id)}
              className={`block rounded-md px-2 py-1.5 ${chapterId === index.intro.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              Overview
            </Link>
            {index.parts.map((part) => (
              <div key={part.id} className="mt-6">
                <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
                  {part.title}
                </p>
                <ul className="space-y-0.5">
                  {part.chapters.map((ch) => (
                    <li key={ch.id}>
                      <Link
                        href={readerHref(slug, ch.id)}
                        className={`block rounded-md px-2 py-1.5 leading-snug ${chapterId === ch.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                      >
                        {formatChapterTitle(ch.title)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-10 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-3xl">
            <MarkdownReaderClient content={content} />
          </div>

          <nav className="mx-auto mt-16 flex max-w-3xl gap-4 border-t border-zinc-800 pt-8">
            {prev ? (
              <Link
                href={readerHref(slug, prev.id)}
                className="flex-1 rounded-xl border border-zinc-800 px-4 py-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
              >
                <span className="block text-xs text-zinc-600">Previous</span>
                <span className="mt-1 line-clamp-2 text-zinc-300">
                  {prev.title}
                </span>
              </Link>
            ) : (
              <div className="flex-1" />
            )}
            {next ? (
              <Link
                href={readerHref(slug, next.id)}
                className="flex-1 rounded-xl border border-zinc-800 px-4 py-3 text-right text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
              >
                <span className="block text-xs text-zinc-600">Next</span>
                <span className="mt-1 line-clamp-2 text-zinc-300">
                  {next.title}
                </span>
              </Link>
            ) : null}
          </nav>
        </main>
      </div>
    </div>
  );
}

export function ReaderView({ slug }: ReaderViewProps) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0c0c0f] text-zinc-100">
          <main className="px-4 py-10 text-zinc-500">Loading…</main>
        </div>
      }
    >
      <ReaderViewInner slug={slug} />
    </Suspense>
  );
}

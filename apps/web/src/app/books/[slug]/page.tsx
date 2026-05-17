import Link from "next/link";
import { notFound } from "next/navigation";
import { TypeBadge } from "@/components/catalog/TypeBadge";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { getBookIndex } from "@/lib/books";

interface BookPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BookPage({ params }: BookPageProps) {
  const { slug } = await params;
  const index = await getBookIndex(slug);
  if (!index) notFound();

  const { meta, intro, parts } = index;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader showBack backHref="/" backLabel="Library" />
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <TypeBadge type={meta.type} />
        <h1 className="mt-4 font-serif text-4xl font-semibold tracking-tight">
          {meta.title}
        </h1>
        {meta.subtitle ? (
          <p className="mt-3 text-lg text-zinc-500">{meta.subtitle}</p>
        ) : null}

        <Link
          href={`/books/${slug}/read/${intro.id}`}
          className="mt-8 flex items-center justify-between rounded-xl border border-violet-500/30 bg-violet-500/10 px-5 py-4 transition hover:bg-violet-500/15"
        >
          <span className="font-medium text-violet-200">Start reading</span>
          <span className="text-violet-400">→</span>
        </Link>

        <nav className="mt-12 space-y-10" aria-label="Table of contents">
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
              Overview
            </h2>
            <Link
              href={`/books/${slug}/read/${intro.id}`}
              className="block rounded-lg px-3 py-2 text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
            >
              {intro.title}
            </Link>
          </section>

          {parts.map((part) => (
            <section key={part.id}>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                {part.title}
              </h2>
              <ul className="space-y-1">
                {part.chapters.map((chapter) => (
                  <li key={chapter.id}>
                    <Link
                      href={`/books/${slug}/read/${encodeURIComponent(chapter.id)}`}
                      className="block rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
                    >
                      {chapter.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </main>
    </div>
  );
}

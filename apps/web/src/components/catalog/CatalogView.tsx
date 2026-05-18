"use client";

import { useEffect, useState } from "react";
import { BookCard } from "@/components/catalog/BookCard";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { getCatalog } from "@/lib/catalog";
import type { BookMeta } from "@/lib/types";

export function CatalogView() {
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCatalog()
      .then(setBooks)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load catalog"),
      );
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-widest text-violet-400/90">
            Your library
          </p>
          <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
            Read without friction
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-zinc-400">
            Books written by your AI agent — technical deep dives, mental models,
            and startup craft. Pick one and read.
          </p>
        </div>

        <section className="mt-14">
          <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-zinc-500">
            Catalog
          </h2>
          {error ? (
            <p className="text-amber-400/90">{error}</p>
          ) : books === null ? (
            <p className="text-zinc-500">Loading catalog…</p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              {books.map((book) => (
                <BookCard key={book.slug} book={book} />
              ))}
            </div>
          )}
          {books?.length === 0 ? (
            <p className="text-zinc-500">No books in the catalog yet.</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}

import Link from "next/link";
import type { BookMeta } from "@/lib/types";
import { TypeBadge } from "./TypeBadge";

interface BookCardProps {
  book: BookMeta;
}

export function BookCard({ book }: BookCardProps) {
  return (
    <Link
      href={`/books/${book.slug}`}
      className="group flex flex-col rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 transition hover:border-zinc-700 hover:bg-zinc-900/70"
    >
      <TypeBadge type={book.type} />
      <h2 className="mt-4 font-serif text-2xl font-semibold tracking-tight text-zinc-50 group-hover:text-white">
        {book.title}
      </h2>
      {book.subtitle ? (
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {book.subtitle}
        </p>
      ) : null}
      <p className="mt-4 flex-1 text-sm leading-relaxed text-zinc-400">
        {book.description}
      </p>
      <span className="mt-6 text-sm font-medium text-violet-400 group-hover:text-violet-300">
        Open book →
      </span>
    </Link>
  );
}

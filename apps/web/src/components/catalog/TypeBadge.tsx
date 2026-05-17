import type { BookType } from "@/lib/types";
import { BOOK_TYPE_LABELS } from "@/lib/types";

const STYLES: Record<BookType, string> = {
  technical: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  "mental-models": "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  "startup-things": "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

interface TypeBadgeProps {
  type: BookType;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[type]}`}
    >
      {BOOK_TYPE_LABELS[type]}
    </span>
  );
}

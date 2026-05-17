export type BookType = "technical" | "mental-models" | "startup-things";

export interface BookMeta {
  slug: string;
  title: string;
  subtitle?: string;
  description: string;
  type: BookType;
  folder: string;
}

export interface ChapterRef {
  id: string;
  title: string;
  relativePath: string;
  order: number;
}

export interface PartRef {
  id: string;
  title: string;
  chapters: ChapterRef[];
}

export interface BookIndex {
  meta: BookMeta;
  intro: ChapterRef;
  parts: PartRef[];
}

export const BOOK_TYPE_LABELS: Record<BookType, string> = {
  technical: "Technical",
  "mental-models": "Mental Models",
  "startup-things": "Startup",
};

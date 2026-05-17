import path from "path";

/** Monorepo `books/` directory (sibling of `apps/web`). */
export const BOOKS_ROOT = path.join(process.cwd(), "..", "..", "books");

export const CATALOG_PATH = path.join(
  process.cwd(),
  "..",
  "..",
  "catalog",
  "books.json",
);

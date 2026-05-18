import { fetchContentText } from "./content-store";
import type { BookMeta } from "./types";

interface CatalogFile {
  books: BookMeta[];
}

export async function getCatalog(): Promise<BookMeta[]> {
  const raw = await fetchContentText("catalog/books.json");
  if (!raw) {
    throw new Error("catalog/books.json not found on content CDN");
  }
  const data = JSON.parse(raw) as CatalogFile;
  return data.books;
}

export async function getBookMeta(slug: string): Promise<BookMeta | undefined> {
  const books = await getCatalog();
  return books.find((b) => b.slug === slug);
}

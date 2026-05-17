import { readFile } from "fs/promises";
import { CATALOG_PATH } from "./paths";
import type { BookMeta } from "./types";

interface CatalogFile {
  books: BookMeta[];
}

export async function getCatalog(): Promise<BookMeta[]> {
  const raw = await readFile(CATALOG_PATH, "utf-8");
  const data = JSON.parse(raw) as CatalogFile;
  return data.books;
}

export async function getBookMeta(slug: string): Promise<BookMeta | undefined> {
  const books = await getCatalog();
  return books.find((b) => b.slug === slug);
}

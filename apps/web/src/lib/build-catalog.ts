import { readFileSync } from "node:fs";
import path from "node:path";

/** Slugs from repo catalog (build-time only; runtime catalog comes from S3). */
export function getBuildCatalogSlugs(): string[] {
  const catalogPath = path.join(process.cwd(), "..", "..", "catalog", "books.json");
  const data = JSON.parse(readFileSync(catalogPath, "utf-8")) as {
    books: { slug: string }[];
  };
  return data.books.map((b) => b.slug);
}

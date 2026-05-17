import { readdir, readFile } from "fs/promises";
import path from "path";
import { getBookMeta } from "./catalog";
import { BOOKS_ROOT } from "./paths";
import type { BookIndex, ChapterRef, PartRef } from "./types";

function isPartDirectory(name: string): boolean {
  return /^(?:part|Part)-\d+/i.test(name);
}

function isChapterFile(name: string): boolean {
  if (!name.endsWith(".md")) return false;
  return (
    name.startsWith("CH-") ||
    name.startsWith("chapter-") ||
    name === "_intro.md"
  );
}

function chapterOrder(filename: string): number {
  if (filename === "_intro.md") return 0;
  const match = filename.match(/^(?:CH|chapter)-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : 999;
}

function prettifySegment(segment: string): string {
  return segment
    .replace(/^(?:part|Part)-\d+-/i, "")
    .replace(/^(?:CH|chapter)-\d+-/i, "")
    .replace(/^_intro$/i, "Part overview")
    .replace(/-/g, " ");
}

function formatChapterTitle(title: string): string {
  return title
    .replace(/^CH-\d+:\s*/i, "")
    .replace(/^Chapter\s+\d+:\s*/i, "")
    .trim();
}

async function titleFromMarkdown(filePath: string, fallback: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return fallback;
  return match[1].replace(/\*+/g, "").trim();
}

function toChapterId(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "").split(path.sep).join("/");
}

async function partTitleFromIntro(
  bookDir: string,
  partDirName: string,
  files: string[],
): Promise<string | null> {
  if (!files.includes("_intro.md")) return null;
  const introPath = path.join(bookDir, partDirName, "_intro.md");
  return titleFromMarkdown(introPath, prettifySegment(partDirName));
}

export async function getBookIndex(slug: string): Promise<BookIndex | null> {
  const meta = await getBookMeta(slug);
  if (!meta) return null;

  const bookDir = path.join(BOOKS_ROOT, meta.folder);
  const introPath = path.join(bookDir, "README.md");
  const introTitle = await titleFromMarkdown(introPath, meta.title);

  const intro: ChapterRef = {
    id: "intro",
    title: introTitle,
    relativePath: "README.md",
    order: 0,
  };

  const entries = await readdir(bookDir, { withFileTypes: true });
  const partDirs = entries
    .filter((e) => e.isDirectory() && isPartDirectory(e.name))
    .map((e) => e.name)
    .sort();

  const parts: PartRef[] = [];

  for (const partDirName of partDirs) {
    const partPath = path.join(bookDir, partDirName);
    const files = await readdir(partPath);
    const chapterFiles = files
      .filter(isChapterFile)
      .sort((a, b) => chapterOrder(a) - chapterOrder(b));

    const chapters: ChapterRef[] = [];

    for (const file of chapterFiles) {
      const relativePath = path.join(partDirName, file);
      const fullPath = path.join(bookDir, relativePath);
      const title = await titleFromMarkdown(fullPath, prettifySegment(file));
      chapters.push({
        id: toChapterId(relativePath),
        title,
        relativePath,
        order: chapterOrder(file),
      });
    }

    let partTitle =
      (await partTitleFromIntro(bookDir, partDirName, files)) ??
      prettifySegment(partDirName);

    if (!files.includes("_intro.md") && chapterFiles.length > 0) {
      const firstChapterPath = path.join(bookDir, partDirName, chapterFiles[0]);
      const content = await readFile(firstChapterPath, "utf-8");
      const partLine = content.match(
        />\s*\*\*Part\s+\d+\s+of\s+\d+\s*·\s*(.+?)\*\*/,
      );
      if (partLine) partTitle = partLine[1].trim();
    }

    parts.push({
      id: partDirName,
      title: partTitle,
      chapters,
    });
  }

  return { meta, intro, parts };
}

export async function getChapterMarkdown(
  slug: string,
  chapterId: string,
): Promise<{ content: string; title: string } | null> {
  const index = await getBookIndex(slug);
  if (!index) return null;

  let relativePath: string | undefined;
  let fallbackTitle = "Chapter";

  if (chapterId === "intro") {
    relativePath = index.intro.relativePath;
    fallbackTitle = index.intro.title;
  } else {
    for (const part of index.parts) {
      const chapter = part.chapters.find((c) => c.id === chapterId);
      if (chapter) {
        relativePath = chapter.relativePath;
        fallbackTitle = chapter.title;
        break;
      }
    }
  }

  if (!relativePath) return null;

  const filePath = path.join(BOOKS_ROOT, index.meta.folder, relativePath);
  const content = await readFile(filePath, "utf-8");
  const title = await titleFromMarkdown(filePath, fallbackTitle);

  return { content, title };
}

export function getAdjacentChapters(
  index: BookIndex,
  chapterId: string,
): { prev?: ChapterRef; next?: ChapterRef } {
  const flat: ChapterRef[] = [index.intro, ...index.parts.flatMap((p) => p.chapters)];
  const i = flat.findIndex((c) => c.id === chapterId);
  if (i < 0) return {};
  return {
    prev: i > 0 ? flat[i - 1] : undefined,
    next: i < flat.length - 1 ? flat[i + 1] : undefined,
  };
}

export { formatChapterTitle };

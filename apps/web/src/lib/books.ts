import {
  fetchContentText,
  listContentDir,
} from "./content-store";
import { getBookMeta, getCatalog } from "./catalog";
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

async function titleFromMarkdown(
  assetPath: string,
  fallback: string,
): Promise<string> {
  const content = await fetchContentText(assetPath);
  if (!content) return fallback;
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return fallback;
  return match[1].replace(/\*+/g, "").trim();
}

function chapterIdFromAsset(bookRoot: string, assetPath: string): string {
  return assetPath
    .replace(`${bookRoot}/`, "")
    .replace(/\.md$/i, "");
}

async function partTitleFromIntro(
  partPath: string,
  files: string[],
  fallback: string,
): Promise<string> {
  if (!files.includes("_intro.md")) return fallback;
  return titleFromMarkdown(`${partPath}/_intro.md`, fallback);
}

export async function getAllBookSlugs(): Promise<string[]> {
  const books = await getCatalog();
  return books.map((b) => b.slug);
}

export async function getBookIndex(slug: string): Promise<BookIndex | null> {
  const meta = await getBookMeta(slug);
  if (!meta) return null;

  const bookRoot = `books/${meta.folder}`;
  const introPath = `${bookRoot}/README.md`;
  const introTitle = await titleFromMarkdown(introPath, meta.title);

  const intro: ChapterRef = {
    id: "intro",
    title: introTitle,
    assetPath: introPath,
    order: 0,
  };

  const partDirs = (await listContentDir(bookRoot)).filter(isPartDirectory);
  const parts: PartRef[] = [];

  for (const partDirName of partDirs) {
    const partPath = `${bookRoot}/${partDirName}`;
    const files = await listContentDir(partPath);
    const chapterFiles = files
      .filter(isChapterFile)
      .sort((a, b) => chapterOrder(a) - chapterOrder(b));

    const chapters: ChapterRef[] = [];
    for (const file of chapterFiles) {
      const assetPath = `${partPath}/${file}`;
      const title = await titleFromMarkdown(assetPath, prettifySegment(file));
      chapters.push({
        id: chapterIdFromAsset(bookRoot, assetPath),
        title,
        assetPath,
        order: chapterOrder(file),
      });
    }

    let partTitle =
      (await partTitleFromIntro(
        partPath,
        files,
        prettifySegment(partDirName),
      )) ?? prettifySegment(partDirName);

    if (!files.includes("_intro.md") && chapterFiles.length > 0) {
      const firstContent = await fetchContentText(
        `${partPath}/${chapterFiles[0]}`,
      );
      if (firstContent) {
        const partLine = firstContent.match(
          />\s*\*\*Part\s+\d+\s+of\s+\d+\s*·\s*(.+?)\*\*/,
        );
        if (partLine) partTitle = partLine[1].trim();
      }
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

  let assetPath: string | undefined;
  let fallbackTitle = "Chapter";

  if (chapterId === "intro") {
    assetPath = index.intro.assetPath;
    fallbackTitle = index.intro.title;
  } else {
    for (const part of index.parts) {
      const chapter = part.chapters.find((c) => c.id === chapterId);
      if (chapter) {
        assetPath = chapter.assetPath;
        fallbackTitle = chapter.title;
        break;
      }
    }
  }

  if (!assetPath) return null;

  const content = await fetchContentText(assetPath);
  if (content === null) return null;

  const title = await titleFromMarkdown(assetPath, fallbackTitle);
  return { content, title };
}

export function getAdjacentChapters(
  index: BookIndex,
  chapterId: string,
): { prev?: ChapterRef; next?: ChapterRef } {
  const flat: ChapterRef[] = [
    index.intro,
    ...index.parts.flatMap((p) => p.chapters),
  ];
  const i = flat.findIndex((c) => c.id === chapterId);
  if (i < 0) return {};
  return {
    prev: i > 0 ? flat[i - 1] : undefined,
    next: i < flat.length - 1 ? flat[i + 1] : undefined,
  };
}

export function readerHref(slug: string, chapterId: string): string {
  const q = encodeURIComponent(chapterId);
  return `/books/${slug}/read?chapter=${q}`;
}

export { formatChapterTitle };

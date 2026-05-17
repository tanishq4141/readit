#!/usr/bin/env node
/**
 * Remove GitHub-style prev/next markdown links from chapter files.
 * Keeps "## What's Next" prose; drops [→ Next] / *[← Previous | → Next]* footers.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bookRoot = path.resolve(__dirname, "../books/designing-ci-cd-pipelines");

async function walkChapters(dir) {
  const files = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await walkChapters(full)));
    else if (/^chapter-.*\.md$/i.test(ent.name)) files.push(full);
  }
  return files;
}

function stripNavLinks(content) {
  let s = content;

  // Standalone: [→ Next: Chapter N — Title](./path.md)
  s = s.replace(/^\[→ Next:[^\n]+\]\([^)]+\)\s*\n/gm, "");

  // Previous-only footer (last chapter): *[← Previous: ...]*
  s = s.replace(/^\*\[← Previous:[^\n]+\]\([^)]+\)\*\s*\n/gm, "");

  // Footer block: --- then italic prev/next (one or two lines)
  s = s.replace(
    /\n---\n\*?\[← Previous:[\s\S]*?(?:\]\([^)]+\)\s*\|\s*)?(?:\[→ Next:[\s\S]*?\]\([^)]+\)\s*)?\*?\s*\n/g,
    "\n",
  );

  // Chapter 1 style: --- then *[→ Next only]*
  s = s.replace(/\n---\n\*\[→ Next:[^\n]+\]\([^)]+\)\*\s*\n/g, "\n");

  // Trailing horizontal rule left before removed nav
  s = s.replace(/\n---\s*$/g, "\n");

  return s.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function main() {
  const files = await walkChapters(bookRoot);
  let changed = 0;
  for (const file of files) {
    const before = await readFile(file, "utf-8");
    const after = stripNavLinks(before);
    if (after !== before) {
      await writeFile(file, after, "utf-8");
      changed++;
    }
  }
  console.log(`Updated ${changed} chapter files under ${bookRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Build content-manifest.json for GitLab OTA sync.
 * Paths match Android BookRepository expectations (catalog/books.json, books/...).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const EXCLUDE_DIRS = new Set([".claude", "node_modules", ".git"]);

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.join(repoRoot, "dist", "content-manifest.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      out = path.resolve(args[++i]);
    }
  }
  return { out };
}

async function walkDir(absDir, prefix) {
  const files = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    if (ent.isDirectory() && EXCLUDE_DIRS.has(ent.name)) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      files.push(...(await walkDir(full, rel)));
    } else if (ent.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function hashFile(absPath) {
  const buf = await readFile(absPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, size: buf.length };
}

async function main() {
  const { out } = parseArgs();
  const relPaths = [];

  const catalogPath = "catalog/books.json";
  const catalogAbs = path.join(repoRoot, catalogPath);
  relPaths.push(catalogPath);

  const booksAbs = path.join(repoRoot, "books");
  const bookFiles = await walkDir(booksAbs, "books");
  relPaths.push(...bookFiles);

  relPaths.sort();

  const files = [];
  for (const rel of relPaths) {
    const abs = path.join(repoRoot, rel);
    const { sha256, size } = await hashFile(abs);
    files.push({ path: rel.replace(/\\/g, "/"), sha256, size });
  }

  const version =
    process.env.CONTENT_VERSION ||
    process.env.CI_COMMIT_SHORT_SHA ||
    new Date().toISOString().replace(/[:.]/g, "-");

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    files,
  };

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${files.length} files to ${out} (version=${version})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

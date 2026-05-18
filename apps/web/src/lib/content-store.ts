import { contentUrl } from "./content-url";

export interface ContentManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ContentManifest {
  version: string;
  generatedAt: string;
  files: ContentManifestFile[];
}

let manifestCache: Promise<ContentManifest> | null = null;

export function resetContentCache(): void {
  manifestCache = null;
}

async function fetchText(path: string): Promise<string | null> {
  const res = await fetch(contentUrl(path), { cache: "default" });
  if (!res.ok) return null;
  return res.text();
}

export async function fetchContentManifest(): Promise<ContentManifest> {
  if (!manifestCache) {
    manifestCache = (async () => {
      const raw = await fetchText("content-manifest.json");
      if (!raw) {
        throw new Error(
          "Could not load content-manifest.json from S3. Run content:publish on main.",
        );
      }
      return JSON.parse(raw) as ContentManifest;
    })();
  }
  return manifestCache;
}

/** Immediate child names under a manifest directory (e.g. part folders). */
export async function listContentDir(dirPath: string): Promise<string[]> {
  const manifest = await fetchContentManifest();
  const prefix = dirPath.replace(/\/?$/, "/");
  const names = new Set<string>();
  for (const { path } of manifest.files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const segment = rest.split("/")[0];
    if (segment) names.add(segment);
  }
  return [...names].sort();
}

export { fetchText as fetchContentText };

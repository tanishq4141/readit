/** Public S3 prefix (same as Android READIT_CONTENT_BASE_URL). Must end with `/`. */
export function getContentBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_READIT_CONTENT_BASE_URL?.trim() ?? "";
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_READIT_CONTENT_BASE_URL is not set (e.g. https://bucket.s3.region.amazonaws.com/readit/)",
    );
  }
  return base.endsWith("/") ? base : `${base}/`;
}

export function contentUrl(relativePath: string): string {
  const base = getContentBaseUrl();
  const path = relativePath.replace(/^\/+/, "");
  return new URL(path, base).href;
}

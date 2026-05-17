import Link from "next/link";

interface SiteHeaderProps {
  backHref?: string;
  backLabel?: string;
  title?: string;
  showBack?: boolean;
}

export function SiteHeader({
  backHref = "/",
  backLabel = "Library",
  title = "Readit",
  showBack = false,
}: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        {showBack ? (
          <>
            <Link
              href={backHref}
              className="text-sm text-zinc-500 transition hover:text-zinc-300"
            >
              ← {backLabel}
            </Link>
            <span className="text-zinc-700">|</span>
          </>
        ) : null}
        <Link
          href="/"
          className="font-serif text-lg font-semibold tracking-tight text-zinc-100"
        >
          {title}
        </Link>
      </div>
    </header>
  );
}

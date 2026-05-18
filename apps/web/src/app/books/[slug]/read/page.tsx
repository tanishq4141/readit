import { ReaderView } from "@/components/reader/ReaderView";
import { getBuildCatalogSlugs } from "@/lib/build-catalog";

export function generateStaticParams() {
  return getBuildCatalogSlugs().map((slug) => ({ slug }));
}

interface ReaderPageProps {
  params: Promise<{ slug: string }>;
}

export default async function ReaderPage({ params }: ReaderPageProps) {
  const { slug } = await params;
  return <ReaderView slug={slug} />;
}

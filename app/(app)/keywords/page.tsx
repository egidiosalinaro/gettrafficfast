import { redirect } from "next/navigation";
import { LEGACY_CONTENT_REDIRECTS, withQuery } from "@/lib/content-paths";

/** Keywords became the topics of Content (`/content/topics`); the query string is kept. */
export default async function LegacyKeywordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(withQuery(LEGACY_CONTENT_REDIRECTS["/keywords"], await searchParams));
}

import { redirect } from "next/navigation";
import { LEGACY_CONTENT_REDIRECTS, withQuery } from "@/lib/content-paths";

/** The oldest Keywords address: the topics of Content now; the query string is kept. */
export default async function LegacyDashboardKeywordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(withQuery(LEGACY_CONTENT_REDIRECTS["/dashboard/keywords"], await searchParams));
}

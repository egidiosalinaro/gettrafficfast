import { redirect } from "next/navigation";
import { LEGACY_CONTENT_REDIRECTS, withQuery } from "@/lib/content-paths";

/** Articles became "All articles" in Content (`/content/articles`); the query string is kept. */
export default async function LegacyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(withQuery(LEGACY_CONTENT_REDIRECTS["/dashboard/calendar"], await searchParams));
}

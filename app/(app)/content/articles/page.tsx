import { redirect } from "next/navigation";
import { LEGACY_CONTENT_REDIRECTS, withQuery } from "@/lib/content-paths";

/**
 * "All articles" became Content's first view: the calendar is `/content`.
 * The query string is kept, so `?article=<id>` still opens that article.
 */
export default async function ContentArticlesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(withQuery(LEGACY_CONTENT_REDIRECTS["/content/articles"], await searchParams));
}

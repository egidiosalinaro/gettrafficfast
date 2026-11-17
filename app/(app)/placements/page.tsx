import { redirect } from "next/navigation";
import { APP_HOME } from "@/lib/app-home";
import { withQuery } from "@/lib/content-paths";

/**
 * Replies became Today (2026-11-14). An old link, a bookmark and the
 * Growth pages' `?source=ai_visibility` still land in the right place: the
 * query string is kept.
 */
export default async function PlacementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery(APP_HOME, await searchParams));
}

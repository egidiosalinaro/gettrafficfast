import { redirect } from "next/navigation";
import { APP_HOME } from "@/lib/app-home";
import { withQuery } from "@/lib/content-paths";

/**
 * The Overview became part of Today (2026-11-14): what needed a person there
 * (a held or failed article) is under "Also today". The query string is kept.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(withQuery(APP_HOME, await searchParams));
}

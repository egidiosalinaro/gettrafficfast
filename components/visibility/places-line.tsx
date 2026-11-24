import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { AI_CITED_FILTER } from "@/lib/placements/read";
import { GROWTH_AI_SETTINGS_PATH } from "@/lib/growth/routes";
import { cn, pluralize } from "@/lib/utils";

/** Phones get a 44px target; from md up the link sits in the sentence. */
const TOUCH_LINK = "inline-flex min-h-[44px] items-center md:min-h-0";

/** The reply inbox (Today) narrowed to the pages a sampled AI answer cited. */
export const CITED_PLACES_HREF = `/today?source=${AI_CITED_FILTER}`;

/**
 * Growth → AI answers: the one line about the places the answers led to
 * (docs/AI_VISIBILITY.md, "From sources to Replies").
 *
 * Each visibility run sends the pages its answers cited, where the site was
 * not cited, to the reply inbox in Today by itself. The line says how many
 * of them are open there now, with the link to them; with the setting off it
 * says where to turn it on. None open gets no line, never a "0", and a count
 * that could not be read (`null`) is no line either.
 */
export function PlacesLine({
  placesFromSources,
  count,
  className,
}: {
  placesFromSources: boolean;
  /** Open places in Today that a sampled answer cited; null when it could not be read. */
  count: number | null;
  className?: string;
}) {
  if (count !== null && count > 0) {
    return (
      <p className={cn("flex items-start gap-2", className)}>
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <span>
          {pluralize(count, "page")} the answers cited {count === 1 ? "is" : "are"} in Today, as {count === 1 ? "a place" : "places"} to
          reply.{" "}
          <Link href={CITED_PLACES_HREF} className={`${TOUCH_LINK} font-medium underline underline-offset-2`}>
            Open {count === 1 ? "it" : "them"}
          </Link>
        </span>
      </p>
    );
  }
  if (!placesFromSources) {
    return (
      <p className={cn("text-muted-foreground", className)}>
        Cited pages are not sent to Today: this site turned it off in{" "}
        <Link href={`${GROWTH_AI_SETTINGS_PATH}#places`} className={`${TOUCH_LINK} font-medium text-foreground underline underline-offset-2`}>
          Configure
        </Link>
        .
      </p>
    );
  }
  return null;
}

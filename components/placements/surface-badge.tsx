import { Favicon } from "@/components/favicon";
import { surfaceDomain, surfaceLabel } from "@/lib/placements/surfaces";
import { cn } from "@/lib/utils";

/**
 * The platform pill on an inbox row: the site's favicon and its name. The
 * icon repeats the name, so it is decoration and hidden from assistive tech
 * (the Favicon component already does that).
 */
export function SurfaceBadge({
  surface,
  community,
  className,
}: {
  surface: string;
  community: string | null;
  className?: string;
}) {
  const domain = surfaceDomain(surface, community);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-foreground/15 px-1.5 py-0.5 font-medium",
        className
      )}
    >
      {domain && <Favicon domain={domain} size={12} />}
      {surfaceLabel(surface)}
    </span>
  );
}

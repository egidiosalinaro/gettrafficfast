import { SectionFrame } from "@/components/dashboard/section-frame";

/**
 * The placeholder a section shows while its server work runs (the site and
 * subscription check in its layout, then the page). One shape for every
 * section: a heading, a row of tiles, a list. It promises nothing about the
 * data: no numbers, no labels, only where things will be.
 *
 * `framed` is for the boundary above the section layouts (app/(app)/
 * loading.tsx), where the section's own frame has not rendered yet; inside a
 * section or the settings column the frame is already on screen.
 */
export function SectionSkeleton({ framed = false }: { framed?: boolean }) {
  const body = (
    <div
      role="status"
      aria-busy="true"
      className="flex w-full flex-col gap-6 animate-pulse"
    >
      <span className="sr-only">Loading</span>
      <div className="space-y-2">
        <div className="h-7 w-40 rounded-md bg-muted" />
        <div className="h-4 w-full max-w-md rounded-md bg-muted" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="h-20 rounded-lg bg-muted" />
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="h-12 rounded-md bg-muted" />
        ))}
      </div>
    </div>
  );

  return framed ? <SectionFrame>{body}</SectionFrame> : body;
}

import { BrandMark } from "@/components/brand-mark";

/**
 * What Replies shows while the inbox loads: the GetTrafficFast mark with a
 * small moon on an orbit around it, centred in the screen, and one line of
 * words. It replaced a bare spinner in the top corner (2026-11-12), which on
 * a phone left the whole screen empty under it.
 *
 * Decoration only: the words are the status (role="status"), the picture is
 * hidden from assistive tech. With reduced motion the orbit stands still.
 */
export function RepliesLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-5 text-center"
    >
      <span aria-hidden="true" className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-full border border-foreground/10" />
        <span className="absolute inset-0 animate-[spin_1.8s_linear_infinite] motion-reduce:animate-none">
          <span className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" />
        </span>
        {/* The mark as a mask filled with the page's own text colour: an <img>
            of /icon.svg follows the phone's colour scheme, not the app's, and
            drew a white mark on the light page when the phone was dark. */}
        <BrandMark className="h-9 w-9 bg-foreground" />
      </span>
      <span className="space-y-1">
        <span className="block text-base font-medium text-foreground">Loading replies</span>
        <span className="block text-sm text-muted-foreground">Gathering the posts worth answering today.</span>
      </span>
    </div>
  );
}

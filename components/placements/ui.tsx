"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The few controls the Replies queue is made of. One primary button per
 * state, chips for the next most likely things, and a ⋯ menu for the rest.
 * On a phone every one of them is 44px tall (a thumb), from `md` up the
 * compact size; no text is under 12px.
 */

/** The one primary action of a state: full width on a phone. */
export const PRIMARY =
  "relative inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50 md:min-h-9 md:w-auto";

/** A secondary action: a quiet pill, never louder than the primary. */
export const CHIP =
  "relative inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/15 bg-background px-3 text-sm text-foreground/80 hover:bg-muted/60 disabled:opacity-50 md:min-h-8 md:text-xs";

/** A plain text field. 16px on a phone (the global rule), so iOS does not zoom. */
export const FIELD =
  "min-h-11 w-full min-w-0 rounded-lg border border-foreground/15 bg-background px-3 text-base text-foreground placeholder:text-muted-foreground md:min-h-9 md:text-sm";

/**
 * A button's label while what it started runs: the label stays, faded to
 * nothing, so the button keeps its size, and a spinner turns in its middle.
 * The button itself is `relative` (PRIMARY and CHIP are) and disabled by its
 * caller, so a second tap does nothing. The label stays in the accessible
 * name; `aria-busy` says the rest.
 */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  if (!busy) return <>{children}</>;
  return (
    <>
      {/* Laid out as the button lays out its own children (`gap` inherited): same width. */}
      <span className="inline-flex items-center gap-[inherit] opacity-0">{children}</span>
      <Loader2 data-busy="" className="absolute h-4 w-4 animate-spin" aria-hidden="true" />
    </>
  );
}

/**
 * One line of a ⋯ menu: an action, or a link that leaves the page. An
 * action that started a request and is still running is `pending`: the ⋯
 * button turns into a spinner until it ends.
 */
export type MenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; pending?: boolean }
  | { label: string; href: string; external?: boolean };

const MENU_ITEM =
  "flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-accent disabled:opacity-50 md:min-h-8";

/**
 * Everything that is not the next step: Copy, Start over, Snooze, Open
 * post, Voice. Behind one ⋯ so the item shows one button, not twelve.
 */
export interface MenuPlace {
  right: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Where a ⋯ menu opens, against the screen and not against its card.
 *
 * It was `absolute` under its button, and the desktop pane and the phone's
 * list both scroll (`overflow-y: auto`), so a menu near the bottom was cut
 * off by the pane's edge. `fixed` is clipped by nothing. It opens below the
 * button when its lines fit there, above when they fit there instead, and on
 * the roomier side with a scroll of its own when they fit on neither.
 */
export function menuPlace(
  button: { top: number; bottom: number; right: number },
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number
): MenuPlace {
  const GAP = 4;
  const EDGE = 8;
  const needed = itemCount * 44 + 10; // a line is at most 44px, plus the padding
  const below = viewportHeight - button.bottom - GAP - EDGE;
  const above = button.top - GAP - EDGE;
  const right = Math.max(EDGE, viewportWidth - button.right);
  if (needed <= below || below >= above) {
    return { right, top: button.bottom + GAP, maxHeight: Math.max(below, 88) };
  }
  return { right, bottom: viewportHeight - button.top + GAP, maxHeight: Math.max(above, 88) };
}

export function MoreMenu({ items, label = "More", className }: { items: MenuItem[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    // The menu is placed against the screen, so it does not follow a scroll.
    function onMove() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setPlace(menuPlace(rect, items.length, window.innerWidth, window.innerHeight));
    setOpen(true);
  }

  if (items.length === 0) return null;
  // Something started from this menu is still running.
  const working = items.some((item) => "onSelect" in item && item.pending);
  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={working || undefined}
        disabled={working}
        onClick={toggle}
        className={cn(CHIP, "min-w-11 px-0 md:min-w-8")}
      >
        {working ? (
          <Loader2 data-busy="" className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      <div
        role="menu"
        hidden={!open}
        style={place ?? undefined}
        className="fixed z-50 w-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {items.map((item) =>
          "href" in item ? (
            <a
              key={item.label}
              role="menuitem"
              href={item.href}
              {...(item.external === false ? {} : { target: "_blank", rel: "noopener noreferrer" })}
              onClick={() => setOpen(false)}
              className={MENU_ITEM}
            >
              {item.label}
            </a>
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={MENU_ITEM}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** A line that says something went wrong, where the person tapped. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-red-700 dark:text-red-400">
      {children}
    </p>
  );
}

/**
 * Whether the screen is wide enough for two panes (the list beside the open
 * item). False on the server and on the first paint, so the phone's layout
 * is the default and nothing jumps on a phone.
 */
export const TWO_PANES = "(min-width: 1024px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

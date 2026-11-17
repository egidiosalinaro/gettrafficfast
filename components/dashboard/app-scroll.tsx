"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * The scrolling area of the signed-in app on a phone.
 *
 * Below `md` the page itself does not scroll: this box does, between the top
 * of the screen and the tab bar, which sits under it in the normal flow.
 * Until 2026-11-10 the tab bar was `position: fixed` over a scrolling page,
 * and on an iPhone, as a home-screen app, iOS left it in the middle of the
 * screen after a change of scroll direction or the keyboard closing (iOS
 * keeps fixed elements on a viewport it has not finished moving). Nothing
 * fixed, nothing to strand.
 *
 * From `md` up the box is `display: contents`: it is not there, and the page
 * scrolls as before beside the fixed sidebar.
 *
 * The router scrolls the window on navigation, which no longer moves on a
 * phone, so a new page starts at its top here.
 */
export function AppScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div
      ref={ref}
      data-app-scroll=""
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-y-contain md:contents"
    >
      {children}
    </div>
  );
}

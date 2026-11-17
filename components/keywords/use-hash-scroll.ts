"use client";

import { useEffect } from "react";

/**
 * Scrolls to `id` once it is on the page, when the address asks for it
 * (`/content/topics#overlapping-topics`). The browser does it by itself only
 * for an element present at load; these sections render after their read.
 */
export function useHashScroll(id: string, ready: boolean) {
  useEffect(() => {
    if (!ready || typeof window === "undefined" || window.location.hash !== `#${id}`) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [id, ready]);
}

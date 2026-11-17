"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { THEME_BACKGROUND, THEME_COLOR } from "@/lib/theme";

/**
 * Keeps the browser's own chrome in the page's colour when a person pins a
 * theme. The theme-color meta tags follow the device's scheme (lib/theme.ts);
 * pinned to Light on a dark phone, Android's address bar would stay dark
 * over a light page. Pinned, both tags take the pinned theme's colour; on
 * System they go back to their per-scheme values. Re-applied after each
 * navigation in case the router re-renders the tags. Renders nothing.
 */
export function ThemeColorSync() {
  const { theme } = useTheme();
  const pathname = usePathname();

  useEffect(() => {
    const pinned = theme === "light" || theme === "dark" ? THEME_BACKGROUND[theme] : null;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      const bySchemes = THEME_COLOR.find((entry) => entry.media === meta.media)?.color;
      const color = pinned ?? bySchemes;
      if (color && meta.content !== color) meta.content = color;
    }
  }, [theme, pathname]);

  return null;
}

import type { MetadataRoute } from "next";
import { APP_HOME } from "@/lib/app-home";
import { APP_BACKGROUND, SITE_NAME } from "@/lib/site";

/**
 * The home-screen app. Opened from its icon it starts on Replies, the
 * section on the tab bar that is used every day (lib/app-home.ts), full
 * screen. Served at /manifest.webmanifest, which lib/public-paths.ts lets
 * through without a session: browsers fetch a manifest without cookies.
 *
 * The colours stay the light theme's. A manifest takes one value and cannot
 * follow the device's colour scheme, and Android only uses it for the splash
 * that shows while the app starts: once the page is up, the theme-color
 * meta tags (lib/theme.ts), which do follow the scheme, paint the bar.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    start_url: APP_HOME,
    display: "standalone",
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}

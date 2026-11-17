import { APP_BACKGROUND, APP_BACKGROUND_DARK } from "@/lib/site";

/**
 * How the app picks its colours: it follows the device. A phone in dark mode
 * gets the dark theme, a phone in light mode the light one, and the switch
 * happens live when the device changes. A person can pin Light or Dark in
 * Settings → Account; that choice lives in this browser only (next-themes
 * keeps it in localStorage under "theme"), never on the server.
 *
 * Until 2026-11-12 the provider forced the light theme everywhere. The rules
 * that keep both themes readable are in docs/THEME.md.
 *
 * - attribute "class": `.dark` on <html>, which the `dark:` variants
 *   (tailwind.config.ts) and the token block in app/globals.css key on.
 * - next-themes writes the class from a blocking script before the first
 *   paint, so a dark device never sees a light flash. <html> carries
 *   suppressHydrationWarning because that script changes it before React.
 * - disableTransitionOnChange: a switch repaints at once instead of fading
 *   every coloured element through its transition.
 */
export const THEME_PROVIDER_PROPS = {
  attribute: "class",
  defaultTheme: "system",
  enableSystem: true,
  disableTransitionOnChange: true,
} as const;

/** What a person can pick, in the order Settings shows it. */
export const THEME_CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number]["value"];

/** The page colour of each theme, as the browser chrome should paint it. */
export const THEME_BACKGROUND: Record<"light" | "dark", string> = {
  light: APP_BACKGROUND,
  dark: APP_BACKGROUND_DARK,
};

/**
 * The browser's own chrome (Android's address bar, Safari's tab bar) in the
 * page's colour, per device scheme. A meta tag can only follow the device;
 * when a person pins a theme that differs from it, ThemeColorSync
 * (components/theme-color-sync.tsx) repaints the tags to match the page.
 */
export const THEME_COLOR: { media: string; color: string }[] = [
  { media: "(prefers-color-scheme: light)", color: THEME_BACKGROUND.light },
  { media: "(prefers-color-scheme: dark)", color: THEME_BACKGROUND.dark },
];

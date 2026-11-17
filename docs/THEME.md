# Theme: light and dark

Last updated: 2026-11-12.

Every page follows the device's colour scheme: the signed-in app, the landing
page, pricing, the blog, the docs, sign-up, the legal pages, the
OAuth consent screen and the error page. A phone in dark mode gets the dark
theme, and the page switches live when the device does. Until 2026-11-12 the
provider forced the light theme, so a phone in dark mode got a white app.

## How it works

- **Provider.** `next-themes`, configured once in `lib/theme.ts`
  (`THEME_PROVIDER_PROPS`) and used by `app/layout.tsx` and
  `app/global-error.tsx`: `attribute: "class"`, `defaultTheme: "system"`,
  `enableSystem: true`, `disableTransitionOnChange: true`, no `forcedTheme`.
- **No flash.** next-themes writes `light` or `dark` on `<html>` from a
  blocking script before the first paint. `<html>` carries
  `suppressHydrationWarning` because that script changes it before React
  hydrates. The body's background is a token, so it is right on the first
  frame.
- **Tokens.** `app/globals.css`: `:root` is the light theme, `.dark` the dark
  one. Each block sets `color-scheme`, so native controls (selects,
  checkboxes, range sliders, scrollbars, date pickers) follow the theme.
- **Browser chrome.** The viewport's `themeColor` is one tag per device scheme
  (`THEME_COLOR` in `lib/theme.ts`), each the page colour of that theme.
  `components/theme-color-sync.tsx` repaints both tags when a person pins a
  theme that differs from the device, so Android's bar matches the page.
  The status-bar strip over the top safe-area inset (`body::before`) uses
  `--background`, so it is dark in the dark theme.
- **Manifest.** `app/manifest.ts` keeps the light colours: a manifest takes
  one value and cannot follow the scheme. Android only uses it for the splash
  while the home-screen app starts; once the page is up, the theme-color tags
  paint the bar.
- **Choice.** Settings → Account → Appearance: System (default), Light, Dark
  (`components/settings/theme-choice.tsx`). next-themes keeps it in this
  browser's localStorage under `theme`. It is a preference of the device in
  hand, not of the account: nothing is saved on the server.
- **iPhone home-screen app.** `appleWebApp.statusBarStyle` stays `default`:
  iOS draws the status bar text for the device's appearance. Pinning Light on
  a dark phone (or the reverse) can leave that text low-contrast over the
  strip; System, the default, never does.

## The tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `0 0% 98%` (#fafafa) | `0 0% 10%` (#1a1a1a) | page |
| `--foreground` | `32 4% 20%` | `0 0% 95%` | text |
| `--card` / `--popover` | white | `0 0% 13%` | cards, menus, sheets |
| `--muted` | `0 0% 96.1%` | `0 0% 18%` | quiet fills |
| `--muted-foreground` | `0 0% 45.1%` | `0 0% 70%` | secondary text |
| `--border` / `--input` | `0 0% 89.8%` | `0 0% 23%` / `25%` | lines, fields |
| `--primary` | near black | near white | primary button |
| `--ring` | near black | `0 0% 83.1%` | focus ring |
| `--chart-1..5` | blue, orange, slate, gold, light orange | same hues, slot 3 lifted | data viz, every slot ≥ 3:1 on its background |

`lib/site.ts` holds each theme's `--background` as hex (`APP_BACKGROUND`,
`APP_BACKGROUND_DARK`) for the browser chrome; `tests/theme.test.tsx` fails if
they drift from the CSS.

## Rules

1. **Tokens first.** `bg-background`, `bg-card`, `bg-muted`, `text-foreground`,
   `text-muted-foreground`, `border-border`, `bg-primary`. A component written
   with tokens needs nothing per theme.
2. **Status colours carry a `dark:` partner**, in the same class string:
   - pale fill `bg-X-50` / `bg-X-100` → `dark:bg-X-950/40` (a tint, not the
     opaque 950, which reads as a brown or green slab);
   - deep text `text-X-700` / `800` / `900` → `dark:text-X-300` (or `400`);
   - `text-X-600` → `dark:text-X-400`;
   - pale border `border-X-200` / `300` → `dark:border-X-800`.
   Mid shades (`bg-X-500` dots, `bg-X-500/10` tints, white on `bg-X-600`
   swipe layers) read on both and need no partner.
3. **No `bg-white` or `text-black` without `dark:`.** `tests/theme.test.tsx`
   scans `app/` and `components/` and fails on a pale status fill, border or
   deep status text, or a white surface or black text, with no `dark:`
   partner. Only the Open Graph image routes are exempt: they are images for
   other sites and stay light.
4. **Never `<img src="/icon.svg">` inside the UI.** The SVG carries its own
   `prefers-color-scheme` rule, for the browser tab: it follows the device,
   not the app's theme, and draws a white mark on a light page when the
   device is dark. Use `BrandMark` (`components/brand-mark.tsx`): the SVG as a
   CSS mask over `currentColor`, so the mark is the colour of the text next
   to it. The old black-on-white PNG is no longer used anywhere in the UI.
5. **Third-party images.** Favicons (`components/favicon.tsx`) sit on a white
   chip in the dark theme: many are a black glyph on transparent and vanish
   on a dark page. Photos and avatars need nothing.
6. **Overlays** stay `bg-black/40`–`/80`: a scrim is dark in both themes.

## Not themed, on purpose

- The Open Graph cards (`app/blog/[slug]/opengraph-image.tsx`, `public/og/`):
  images other sites show, always light.
- Emails (`lib/notifications/email.ts`): inline-styled HTML for mail clients,
  which apply their own dark handling. There is no web view of an email.
- The favicon set (`/icon.svg` adapts by itself; `/favicon.ico` is a tile).

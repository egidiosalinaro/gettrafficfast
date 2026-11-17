import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { ThemeProvider } from "next-themes";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { SITE_HOST, SITE_NAME, SITE_URL } from "@/lib/site";
import { THEME_COLOR, THEME_PROVIDER_PROPS } from "@/lib/theme";
import "./globals.css";

// The template used VERCEL_URL here, which on Vercel is the DEPLOYMENT url
// (project-hash-team.vercel.app), not the custom domain. Deployment urls sit
// behind Vercel's auth wall, so every og:image the site advertised pointed at
// a login page and no crawler (WhatsApp's included) could ever fetch it.
const defaultUrl = SITE_URL;

const DATAFAST_WEBSITE_ID = process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID;

/**
 * A browser that reads neither the manifest nor appleWebApp offers the page
 * title as the home-screen name, so the title carries no em dash.
 */
const TITLE = `${SITE_NAME}: See if AI recommends your product`;

/** Search results cut near 160 characters, social cards near 125. */
const SEARCH_DESCRIPTION =
  "Track the prompts you choose on Gemini and Perplexity. See who gets cited, then publish the page or reply that should be the source.";
const SOCIAL_DESCRIPTION =
  "See if AI cites your product on the prompts you chose, then publish what should be the source.";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Each theme's page colour (--background, app/globals.css), per device
  // scheme: the browser bar matches the page in light and in dark.
  themeColor: THEME_COLOR,
};

export const metadata: Metadata = {
  metadataBase: new URL(defaultUrl),
  title: TITLE,
  description: SEARCH_DESCRIPTION,
  applicationName: SITE_NAME,
  // Added to an iPhone's home screen, the app opens full screen under its
  // own name. The manifest (app/manifest.ts) says the same for Android.
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: "default",
  },
  // Every page without its own openGraph inherits this card. It replaces the
  // starter template's artwork, which is what the site advertised until now.
  openGraph: {
    title: TITLE,
    description: SOCIAL_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
    url: "/",
    images: [
      {
        url: "/og/home.png",
        width: 1200,
        height: 630,
        alt: "GetTrafficFast: see if AI recommends your product.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: SOCIAL_DESCRIPTION,
    images: ["/og/home.png"],
  },
  // Two icons, and only two, so a browser has nothing wrong to pick:
  // - /icon.svg, the mark alone, which carries its own prefers-color-scheme
  //   rule: black on a light browser, white on a dark one;
  // - /favicon.ico, the white mark on a black tile, for whatever cannot draw
  //   the SVG or ignores the scheme (Google Search and its favicon service,
  //   which the site switcher uses). A tile is visible on any background.
  // The .ico says 32x32, not "any": with "any" Chrome takes it over the SVG.
  // Until 2026-11-10 the unconditional icons were the black mark on
  // transparent, which a dark tab drew as nothing, next to light and dark
  // PNGs declared with a media attribute that lost to them.
  // robots.txt must allow these files (app/robots.ts), or Google shows none.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html>
    // from a blocking script before React hydrates (lib/theme.ts).
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Visitor analytics for this site. Distinct from Search Console
            (docs/ANALYTICS.md). Root layout so every route loads it. The
            property is per deployment: no NEXT_PUBLIC_DATAFAST_WEBSITE_ID,
            no script. See docs/DATAFAST.md. */}
        {DATAFAST_WEBSITE_ID ? (
          <Script
            src="https://datafa.st/js/script.js"
            data-website-id={DATAFAST_WEBSITE_ID}
            data-domain={SITE_HOST}
            strategy="afterInteractive"
          />
        ) : null}
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {/* Follows the device's colour scheme; Settings → Account can pin
            Light or Dark. The config and its reasons are in lib/theme.ts. */}
        <ThemeProvider {...THEME_PROVIDER_PROPS}>
          <ThemeColorSync />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

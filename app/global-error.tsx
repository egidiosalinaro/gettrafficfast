"use client";

import * as Sentry from "@sentry/nextjs";
import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { THEME_PROVIDER_PROPS } from "@/lib/theme";
import "./globals.css";

/**
 * Replaces the root layout when it fails, so it brings its own stylesheet
 * and theme: a dark device gets the dark page here too.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <ThemeProvider {...THEME_PROVIDER_PROPS}>
          <h2 className="text-2xl font-bold">Something went wrong</h2>
          <p className="text-sm opacity-70">
            The error has been reported. Please try refreshing the page.
          </p>
        </ThemeProvider>
      </body>
    </html>
  );
}

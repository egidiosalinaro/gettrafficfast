"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { THEME_CHOICES, type ThemeChoice as ThemeValue } from "@/lib/theme";

const ICONS: Record<ThemeValue, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** False on the server and in the first client render, true after. */
const subscribeNever = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/**
 * System, Light or Dark. System, the default, follows the device and
 * switches with it. The choice is kept by next-themes in this browser's
 * localStorage: it is a preference of the device in hand, not of the
 * account, so nothing is saved on the server (lib/theme.ts).
 *
 * The server cannot know the stored choice, so no button is marked until
 * the page has hydrated: a wrong mark for a moment would be a small lie.
 */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const current = hydrated ? (theme ?? "system") : null;

  return (
    <div className="grid grid-cols-3 gap-2 sm:max-w-md">
      {THEME_CHOICES.map((choice) => {
        const Icon = ICONS[choice.value];
        const selected = current === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            onClick={() => setTheme(choice.value)}
            aria-pressed={selected}
            className={cn(
              "flex min-h-[44px] items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-foreground ring-1 ring-foreground" : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatCount } from "@/lib/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// This check can be removed, it is just for tutorial purposes
export const hasEnvVars =
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * A count with its noun: "1 keyword", "2 keywords", never "1 keywords".
 * Thousands are grouped in the interface's locale: "1,234 clicks".
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

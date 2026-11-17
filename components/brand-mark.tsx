import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * The GetTrafficFast mark, drawn in the colour of the text around it.
 *
 * It is /icon.svg used as a CSS mask over `currentColor`, never an <img>:
 * an <img> of icon.svg follows the device's colour scheme (the SVG carries
 * its own prefers-color-scheme rule, for the browser tab), not the app's
 * theme, and the old black-on-white PNG was a white square on a dark page.
 * As a mask the mark is whatever colour the text is, in either theme.
 *
 * Decoration: the product's name always sits next to it as text, so it is
 * hidden from assistive tech. Size it with h-/w- classes.
 */
const MASK: CSSProperties = {
  WebkitMaskImage: "url(/icon.svg)",
  maskImage: "url(/icon.svg)",
  WebkitMaskSize: "contain",
  maskSize: "contain",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
};

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-brand-mark=""
      className={cn("inline-block shrink-0 bg-current", className)}
      style={MASK}
    />
  );
}

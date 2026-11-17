"use client";

import { Check, Plus, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Brand colors, picked rather than typed. A hex code is something a form
 * should hand a user, not demand from them: the swatches cover the common
 * brand spectrum and the colour well covers everything else, so the value is
 * valid by construction and never needs validating on save.
 */

const SWATCHES = [
  "#0f172a", "#334155", "#64748b", "#94a3b8",
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
];

/** Mirrors the schema's ceiling: more than a handful stops being a palette. */
export const MAX_BRAND_COLORS = 6;

interface BrandPalettePickerProps {
  value: string[];
  onChange: (colors: string[]) => void;
}

export function BrandPalettePicker({ value, onChange }: BrandPalettePickerProps) {
  const [custom, setCustom] = useState("#1a2b3c");
  const selected = value.map((color) => color.toLowerCase());
  const full = selected.length >= MAX_BRAND_COLORS;

  function toggle(color: string) {
    const hex = color.toLowerCase();
    if (selected.includes(hex)) {
      onChange(selected.filter((c) => c !== hex));
      return;
    }
    if (full) return;
    onChange([...selected, hex]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {SWATCHES.map((color) => {
          const isSelected = selected.includes(color);
          return (
            <button
              key={color}
              type="button"
              onClick={() => toggle(color)}
              disabled={full && !isSelected}
              aria-pressed={isSelected}
              aria-label={color}
              title={color}
              className={cn(
                "h-8 w-8 rounded-full border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isSelected
                  ? "border-foreground/40 ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "border-black/10 hover:scale-110",
                full && !isSelected && "cursor-not-allowed opacity-40 hover:scale-100"
              )}
              style={{ backgroundColor: color }}
            >
              {isSelected && (
                <Check className="mx-auto h-4 w-4 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]" />
              )}
            </button>
          );
        })}

        <span className="flex items-center gap-1 rounded-full border border-dashed border-input px-2 py-1">
          <input
            type="color"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Pick a custom color"
            className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
          />
          <button
            type="button"
            onClick={() => toggle(custom)}
            disabled={full && !selected.includes(custom.toLowerCase())}
            className="flex items-center gap-1 pr-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </span>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {selected.map((color) => (
            <span
              key={color}
              className="flex items-center gap-1.5 rounded-full border border-input py-1 pl-1.5 pr-2 text-xs"
            >
              <span
                className="h-4 w-4 rounded-full border border-black/10"
                style={{ backgroundColor: color }}
              />
              <span className="font-mono text-muted-foreground">{color}</span>
              <button
                type="button"
                onClick={() => toggle(color)}
                aria-label={`Remove ${color}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {full
          ? `That is the full palette (${MAX_BRAND_COLORS} colors). Remove one to pick another.`
          : "Optional. Picked colors are used as accents in generated images, never as the whole scene."}
      </p>
    </div>
  );
}

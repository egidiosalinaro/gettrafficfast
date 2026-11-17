"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A line to paste somewhere else (the MCP address, the Claude Code command),
 * with a Copy button: selecting a long line by hand on a phone is the part
 * people get wrong. The text stays selectable without the button.
 */
export function CopyText({ text, label, small = false }: { text: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row">

      <code
        className={
          "w-full min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border bg-muted px-3 py-2.5 font-mono " +
          (small ? "text-xs" : "text-sm")
        }
      >
        {text}
      </code>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-muted"
      >
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

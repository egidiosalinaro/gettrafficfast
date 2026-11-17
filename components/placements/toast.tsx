"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { InboxToast } from "@/lib/placements/inbox-view";
import { BusyLabel } from "@/components/placements/ui";

/**
 * How long a notice stays before it goes on its own. Long enough to read one
 * sentence and tap its action; short enough that notices never pile up.
 */
export const TOAST_MS = 4_000;

/** A notice on screen: its text, and the action's handler when it has one. */
export interface ShownToast {
  id: number;
  text: string;
  /** The action; when it returns a promise, the notice stays, its button turning, until it settles. */
  action?: { label: string; onClick: () => unknown };
}

type Timer = { current: ReturnType<typeof setTimeout> | null };

function stop(timer: Timer) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/**
 * One notice at a time. A new one replaces the one on screen and restarts the
 * clock: stacked notices were the problem this replaces (the inbox showed a
 * "Post added" box, a "Moved to Posted" banner and the missing-links box at
 * once, on top of the cards).
 */
export function useToast(): {
  toast: ShownToast | null;
  show: (toast: InboxToast, onAction?: () => unknown) => void;
  dismiss: () => void;
} {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback(() => {
    stop(timer);
    setToast(null);
  }, []);

  const show = useCallback((next: InboxToast, onAction?: () => unknown) => {
    stop(timer);
    seq.current += 1;
    setToast({
      id: seq.current,
      text: next.text,
      action:
        next.action && onAction
          ? {
              label: next.action.label,
              // Tapped: the notice no longer goes on its own while the action runs.
              onClick: () => {
                stop(timer);
                return onAction();
              },
            }
          : undefined,
    });
    timer.current = setTimeout(() => {
      timer.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  // Nothing fires after the page is gone.
  useEffect(() => {
    const pending = timer;
    return () => stop(pending);
  }, []);

  return { toast, show, dismiss };
}

/**
 * The notice itself, above the phone's tab bar and centred on the content
 * column from `md` up. The live region is always in the page, so a screen
 * reader hears each notice as it arrives; the region lets taps through
 * everywhere but on the notice.
 */
export function Toast({ toast, onDismiss }: { toast: ShownToast | null; onDismiss: () => void }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-6 md:left-48"
    >
      {toast && <Notice key={toast.id} toast={toast} onDismiss={onDismiss} />}
    </div>
  );
}

function Notice({ toast, onDismiss }: { toast: ShownToast; onDismiss: () => void }) {
  const [working, setWorking] = useState(false);
  return (
        <div
          role="status"
          className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg bg-foreground py-1 pl-4 pr-1 text-sm text-background shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <span className="min-w-0 flex-1 py-2">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              disabled={working}
              aria-busy={working || undefined}
              onClick={async () => {
                if (working) return;
                const result = toast.action?.onClick();
                if (result instanceof Promise) {
                  setWorking(true);
                  try {
                    await result;
                  } finally {
                    setWorking(false);
                  }
                }
                onDismiss();
              }}
              className="relative inline-flex min-h-11 shrink-0 items-center justify-center rounded-md px-2 font-semibold underline underline-offset-2 hover:bg-background/10"
            >
              <BusyLabel busy={working}>{toast.action.label}</BusyLabel>
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-background/70 hover:bg-background/10 hover:text-background"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
  );
}

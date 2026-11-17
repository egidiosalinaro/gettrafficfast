"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Confirm before an action that cannot be taken back, without a native
 * dialog: `window.confirm` is blocked in some in-app browsers and reads as an
 * error on a phone. The first tap asks, in place of the control, right where
 * the finger already is; only the second acts.
 */

export type ConfirmStep = "idle" | "confirming";

/**
 * First tap asks, second tap acts. Pure, so "a single tap never rewrites a
 * live article" is a tested rule rather than a hope about a click handler.
 */
export function confirmTap(step: ConfirmStep): { next: ConfirmStep; act: boolean } {
  return step === "idle" ? { next: "confirming", act: false } : { next: "idle", act: true };
}

/** The answer buttons' default look: a text link, 44px tall on a phone. */
const ANSWER =
  "inline-flex min-h-11 items-center gap-1.5 text-xs text-primary hover:underline md:min-h-0";

/** Answers that sit where an outline `Button` was: same frame, 44px on a phone. */
export const OUTLINE_ANSWER =
  "inline-flex h-11 md:h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm hover:bg-accent";

export interface InlineConfirmViewProps {
  step: ConfirmStep;
  question: string;
  confirmLabel?: string;
  /** The control shown before the first tap; call `ask` from its onClick. */
  trigger: (ask: () => void) => React.ReactNode;
  onTap: () => void;
  onCancel: () => void;
  /** Styling of the two answer buttons. */
  buttonClassName?: string;
  confirmClassName?: string;
  /** Styling of the question and its answers, together. */
  className?: string;
}

/** Stateless, so both steps can be rendered and asserted on their own. */
export function InlineConfirmView({
  step,
  question,
  confirmLabel = "Continue",
  trigger,
  onTap,
  onCancel,
  buttonClassName = ANSWER,
  confirmClassName,
  className,
}: InlineConfirmViewProps) {
  if (step === "idle") return <>{trigger(onTap)}</>;
  return (
    <div role="group" aria-label="Confirm" className={cn("space-y-1", className)}>
      <p className="text-xs font-medium text-foreground">{question}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onTap}
          className={cn(buttonClassName, "font-semibold text-destructive", confirmClassName)}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(buttonClassName, "text-muted-foreground")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The stateful control: the question replaces the trigger on the first tap. */
export function InlineConfirm({
  onConfirm,
  ...view
}: Omit<InlineConfirmViewProps, "step" | "onTap" | "onCancel"> & { onConfirm: () => void }) {
  const [step, setStep] = useState<ConfirmStep>("idle");
  return (
    <InlineConfirmView
      {...view}
      step={step}
      onTap={() => {
        const { next, act } = confirmTap(step);
        setStep(next);
        if (act) onConfirm();
      }}
      onCancel={() => setStep("idle")}
    />
  );
}

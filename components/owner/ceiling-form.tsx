"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineConfirmView, OUTLINE_ANSWER, type ConfirmStep } from "@/components/ui/inline-confirm";
import { parseSpendLimit, raiseQuestion } from "@/lib/limits/settings";
import { formatLimitUsd } from "@/lib/limits/spend";

/**
 * /settings/costs: one account's daily AI spend ceiling, $1 to $100, set by
 * a platform owner (POST /api/owner/spend-limit).
 *
 * Lowering saves on the first tap. Raising lets more money through, so the
 * first tap only asks, in place of the button, and the second saves (the
 * route refuses a raise without that confirmation too,
 * lib/limits/settings.ts).
 */

export type CeilingDecision =
  | { kind: "error"; message: string }
  /** Unchanged: nothing to save. */
  | { kind: "same" }
  /** A raise on the first tap: ask before saving. */
  | { kind: "ask"; value: number }
  | { kind: "save"; value: number; confirm: boolean };

/** What a tap on Save does, from what is typed, the ceiling in force and the confirm step. Pure, so the rule is tested. */
export function decideCeiling(currentUsd: number, raw: string, step: ConfirmStep): CeilingDecision {
  const parsed = parseSpendLimit(raw);
  if (!parsed.ok) return { kind: "error", message: parsed.error };
  if (parsed.value === currentUsd) return { kind: "same" };
  if (parsed.value < currentUsd) return { kind: "save", value: parsed.value, confirm: false };
  return step === "confirming" ? { kind: "save", value: parsed.value, confirm: true } : { kind: "ask", value: parsed.value };
}

export interface CeilingFormViewProps {
  /** Makes the field's id unique on a page that lists many accounts. */
  fieldId: string;
  /** Who the ceiling is for, read by a screen reader with the field. */
  accountLabel: string;
  currentUsd: number;
  value: string;
  step: ConfirmStep;
  saving: boolean;
  error: string | null;
  notice: string | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** Stateless, so both steps can be rendered and asserted on their own. */
export function CeilingFormView({
  fieldId,
  accountLabel,
  currentUsd,
  value,
  step,
  saving,
  error,
  notice,
  onChange,
  onSave,
  onCancel,
}: CeilingFormViewProps) {
  const parsed = parseSpendLimit(value);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <Label htmlFor={fieldId} className="text-xs text-muted-foreground">
        Daily ceiling<span className="sr-only"> for {accountLabel}</span>
      </Label>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex items-center gap-1">
          <span className="text-sm text-muted-foreground">$</span>
          <Input
            id={fieldId}
            inputMode="decimal"
            className="h-11 w-24"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={saving}
          />
        </div>
        <InlineConfirmView
          step={step}
          question={parsed.ok ? raiseQuestion(currentUsd, parsed.value) : ""}
          confirmLabel={parsed.ok ? `Raise to ${formatLimitUsd(parsed.value)}` : "Raise"}
          buttonClassName={OUTLINE_ANSWER}
          onTap={onSave}
          onCancel={onCancel}
          trigger={(ask) => (
            <Button type="button" variant="outline" className="h-11" onClick={ask} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
    </form>
  );
}

export function CeilingForm({ userId, accountLabel, currentUsd }: { userId: string; accountLabel: string; currentUsd: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(currentUsd));
  const [step, setStep] = useState<ConfirmStep>("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(amount: number, confirm: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/owner/spend-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, dailySpendUsd: amount, confirm }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string; dailySpendUsd?: number };
      if (response.status === 409 && payload.code === "confirmation_required") {
        // The ceiling in force changed under the page: ask again.
        setStep("confirming");
        return;
      }
      if (!response.ok) {
        setError(payload.error ?? "The ceiling could not be saved. Try again.");
        setStep("idle");
        return;
      }
      setStep("idle");
      setNotice(`Saved: ${formatLimitUsd(payload.dailySpendUsd ?? amount)} a day.`);
      router.refresh();
    } catch {
      setError("The ceiling could not be saved. Check your connection and try again.");
      setStep("idle");
    } finally {
      setSaving(false);
    }
  }

  function onSave() {
    setNotice(null);
    const decision = decideCeiling(currentUsd, value, step);
    switch (decision.kind) {
      case "error":
        setError(decision.message);
        setStep("idle");
        return;
      case "same":
        setError(null);
        setStep("idle");
        return;
      case "ask":
        setError(null);
        setStep("confirming");
        return;
      case "save":
        void save(decision.value, decision.confirm);
        return;
    }
  }

  return (
    <CeilingFormView
      fieldId={`ceiling-${userId}`}
      accountLabel={accountLabel}
      currentUsd={currentUsd}
      value={value}
      step={step}
      saving={saving}
      error={error}
      notice={notice}
      onChange={(next) => {
        setValue(next);
        setStep("idle");
      }}
      onSave={onSave}
      onCancel={() => setStep("idle")}
    />
  );
}

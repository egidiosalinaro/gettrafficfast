"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * /settings/costs: set up the MCP directory reviewers' account
 * (POST /api/owner/reviewer-account, lib/reviewer-account.ts). One button per
 * address on PASSWORD_LOGIN_EMAILS. Safe to tap again: what exists is kept,
 * and a fresh set-password email is sent.
 */

interface Outcome {
  user: "created" | "existing";
  plan: "comp_granted" | "already_live";
  ceiling: { usd: number; set: boolean };
  site: { created: boolean };
  passwordEmail: { requested: boolean; error: string | null };
}

/** The sentence the panel shows after a tap. Pure, so it is tested. */
export function describeOutcome(email: string, outcome: Outcome): string {
  const parts = [
    outcome.user === "created" ? "Account created" : "Account found",
    outcome.plan === "comp_granted" ? "complimentary plan granted" : "plan already live",
    outcome.ceiling.set ? `AI ceiling set to $${outcome.ceiling.usd}/day` : `AI ceiling kept at $${outcome.ceiling.usd}/day`,
    outcome.site.created ? "demo site added" : "site already there",
  ];
  const mail = outcome.passwordEmail.requested
    ? `The set-password email is on its way to ${email}: open it and choose the password.`
    : `The set-password email was not sent (${outcome.passwordEmail.error ?? "unknown error"}). Tap again in a minute.`;
  return `${parts.join(", ")}. ${mail}`;
}

export function ReviewerAccountPanel({ emails }: { emails: string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const setUp = async (email: string) => {
    setBusy(email);
    setMessage(null);
    try {
      const res = await fetch("/api/owner/reviewer-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => null)) as (Outcome & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? "The account could not be set up.");
      setMessage({ text: describeOutcome(email, body), error: !body.passwordEmail.requested });
    } catch (err: unknown) {
      setMessage({ text: err instanceof Error ? err.message : "The account could not be set up.", error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="reviewer-heading" className="w-full max-w-2xl rounded-2xl border border-border bg-card p-4">
      <h2 id="reviewer-heading" className="text-lg font-semibold">
        Directory reviewer account
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For the MCP directory reviewers: an email and a password, a complimentary plan, a $1/day AI ceiling, the
        gettrafficfa.st demo site and no publishing destination. The password is never shown here: you set it from
        the email.
      </p>
      {emails.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No address is on <code>PASSWORD_LOGIN_EMAILS</code>. Add one on Vercel to set it up here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {emails.map((email) => (
            <li key={email} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{email}</span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setUp(email)}>
                {busy === email ? "Setting up…" : "Set up and send the password email"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p
          role="status"
          className={`mt-3 text-sm ${message.error ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

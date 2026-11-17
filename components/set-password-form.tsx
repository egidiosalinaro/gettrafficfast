"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_HOME } from "@/lib/app-home";
import { MIN_PASSWORD_LENGTH, recoverySessionFromHash } from "@/lib/password-login";

type Stage = "loading" | "ready" | "no_session" | "done";

/**
 * Set the password of an account on PASSWORD_LOGIN_EMAILS, from the email
 * the owner's "Set up the reviewer account" sends (docs/API.md "The reviewer
 * account").
 *
 * The link arrives in one of three shapes, depending on how Supabase answers:
 * a session already in the cookie (the confirm route verified a code or a
 * token hash and sent the person here), a token hash in the query, or the
 * session in the URL fragment (the implicit flow). The fragment is turned
 * into the cookie session and wiped from the address bar. The password is
 * posted to the app's own route, which refuses any account not on the list.
 */
export function SetPasswordForm() {
  const [stage, setStage] = useState<Stage>("loading");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const fromHash = recoverySessionFromHash(window.location.hash);
      if (fromHash) {
        await supabase.auth.setSession(fromHash);
        window.history.replaceState(null, "", window.location.pathname);
      } else {
        const query = new URLSearchParams(window.location.search);
        const tokenHash = query.get("token_hash");
        if (tokenHash && query.get("type") === "recovery") {
          await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
          window.history.replaceState(null, "", window.location.pathname);
        }
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!cancelled) setStage(user ? "ready" : "no_session");
    })().catch(() => {
      if (!cancelled) setStage("no_session");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 404) throw new Error("Password sign-in is not available for this account.");
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "The password was not saved.");
      setPassword("");
      setStage("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The password was not saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Set a password</CardTitle>
        <CardDescription>For signing in with this email and a password.</CardDescription>
      </CardHeader>
      <CardContent>
        {stage === "loading" && <p className="text-sm text-muted-foreground">Checking the link…</p>}
        {stage === "no_session" && (
          <p className="text-sm text-muted-foreground">
            This link has expired or was already used. Ask for a new one, then open it once.
          </p>
        )}
        {stage === "done" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The password is set. Sign in with this email and the password from now on.
            </p>
            <Button className="w-full" onClick={() => window.location.assign(APP_HOME)}>
              Continue
            </Button>
          </div>
        )}
        {stage === "ready" && (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>
            {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
            <Button type="submit" className="w-full" disabled={saving}>
              {saving ? "Saving…" : "Save password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

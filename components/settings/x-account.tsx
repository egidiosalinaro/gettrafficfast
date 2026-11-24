"use client";

import { useState } from "react";
import { AtSign } from "lucide-react";
import { XHandleField } from "@/components/placements/x-handle-field";
import { BusyLabel, CHIP, Problem } from "@/components/placements/ui";

/**
 * X in Settings → Connections (2026-11-24; it was the "Find posts on X"
 * switch until then). The X features have no per-site switch any more: when
 * the platform has the X API on (`available`, `isXApiEnabled` read on the
 * server) they run for every site. What the site still gives is its X
 * account (`voice_settings.xHandle`), which finding the link of a posted
 * reply needs. `inferred` is the handle the site's saved reply links name,
 * shown while none is saved: it is what GTF uses until one is.
 *
 * Since 2026-11-24 the card also connects the X account GTF posts from
 * (`posting`, shown only when the deployment has X_OAUTH_CLIENT_ID and
 * X_OAUTH_CLIENT_SECRET): Connect posts to /api/integrations/x/connect,
 * which opens X's consent screen; Disconnect revokes it. Once connected, its
 * @username is the site's X account (saved as xHandle when none was), so the
 * username field is not asked for any more.
 */

export interface XPostingCardState {
  /** The deployment offers posting on X. */
  available: boolean;
  /** The connected account, or null. */
  account: { username: string; status: "connected" | "error" } | null;
}

/** The line after X's consent screen sent the person back with an error (`x_error`). */
export function xConnectErrorLine(code: string): string {
  switch (code) {
    case "denied":
      return "X was not connected: the request was cancelled on X.";
    case "state_mismatch":
      return "X was not connected: the request expired or came from another browser. Try again.";
    case "site_not_found":
      return "X was not connected: that site is not on this account.";
    case "no_business":
      return "Set up your business first (Settings → Business), then connect X.";
    case "not_configured":
      return "Posting on X is not set up on GetTrafficFast.";
    case "cap_reached":
      return "X could not be connected right now: this month's allowance for X is used up. Try again next month.";
    default:
      return "X could not be connected. Try again in a minute.";
  }
}

export function XAccountCard({
  saved,
  inferred,
  available,
  hasBusiness,
  posting = { available: false, account: null },
  notice = null,
}: {
  saved: string | null;
  inferred: string | null;
  available: boolean;
  hasBusiness: boolean;
  posting?: XPostingCardState;
  /** What the last connect round trip said: connected as @username, or an error line. */
  notice?: { tone: "ok" | "error"; text: string } | null;
}) {
  const connected = posting.available && posting.account !== null;
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex min-h-[44px] items-center gap-3">
        <AtSign className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
        <span className="flex-1 text-[15px] font-medium">X</span>
        <span className="text-sm text-muted-foreground">{available ? "On for every site" : "Not available yet"}</span>
      </div>
      {!available && (
        <p role="status" className="pb-1 text-sm text-muted-foreground">
          Not available yet: reading X is not set up on GetTrafficFast, so nothing is searched or read on X.
        </p>
      )}
      {notice && (
        <p role="status" className={notice.tone === "error" ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-emerald-700 dark:text-emerald-400"}>
          {notice.text}
        </p>
      )}
      {hasBusiness && posting.available && <XPostingRow account={posting.account} />}
      {hasBusiness ? (
        !connected && (
          <XHandleField
            initialValue={saved ?? ""}
            hint={
              saved
                ? "The account this site's replies on X are posted from."
                : inferred
                  ? `From your saved reply links: @${inferred}. Save it, or another one, to be sure.`
                  : "The account this site's replies on X are posted from. GTF needs it to find your replies' links on X."
            }
            className="pb-1"
          />
        )
      ) : (
        <p className="pb-1 text-xs text-muted-foreground">Set up your business first (Settings → Business).</p>
      )}
    </div>
  );
}

/** "The X account GTF posts from": Connect, or the account with Disconnect. */
export function XPostingRow({ account }: { account: XPostingCardState["account"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations/x/disconnect", { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(typeof payload.error === "string" ? payload.error : "Could not disconnect. Try again.");
        return;
      }
      // The page reads the connection on the server: read it again.
      window.location.reload();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const connectForm = (label: string) => (
    <form method="post" action="/api/integrations/x/connect">
      <button type="submit" className={CHIP}>
        {label}
      </button>
    </form>
  );

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <p className="text-sm font-medium">The X account GTF posts from</p>
      {account === null ? (
        <>
          <p className="text-xs text-muted-foreground">
            Connect it, and a reply to a post that mentions or quotes you gets a Post on X button: one press posts it from
            this account. GTF never posts on its own, and replies to everyone else still open in X for you to post.
          </p>
          {connectForm("Connect the X account GTF posts from")}
        </>
      ) : account.status === "error" ? (
        <>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            X no longer accepts the connection to @{account.username}. Connect it again to post from GTF.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {connectForm("Connect again")}
            <button type="button" disabled={busy} onClick={() => void disconnect()} className={CHIP}>
              <BusyLabel busy={busy}>Disconnect</BusyLabel>
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Posting from <span className="font-medium text-foreground">@{account.username}</span>, only when you press Post on X
            (or confirm a post to your AI agent). It is also this site&apos;s X account.
          </p>
          <button type="button" disabled={busy} onClick={() => void disconnect()} className={CHIP}>
            <BusyLabel busy={busy}>Disconnect</BusyLabel>
          </button>
        </>
      )}
      {error && <Problem>{error}</Problem>}
    </div>
  );
}

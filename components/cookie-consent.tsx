"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  analyticsAllowed,
  analyticsCookieNames,
  browserStorage,
  consentReducer,
  expireCookieAssignments,
  INITIAL_CONSENT_STATE,
  OPEN_COOKIE_SETTINGS_EVENT,
  openCookieSettings,
  readConsent,
  writeConsent,
  type ConsentState,
} from "@/lib/cookie-consent";

/**
 * The cookie banner, and the only place the visitor analytics script is
 * mounted (docs/DATAFAST.md). The root layout renders it only when
 * NEXT_PUBLIC_DATAFAST_WEBSITE_ID is set, so a deployment without analytics
 * has neither script nor banner. The rules are in lib/cookie-consent.ts.
 *
 * The server render carries the banner hidden: the stored choice lives in
 * the browser, so the banner shows only once it has been read and found
 * missing. A returning visitor who already chose never sees it flash.
 */

const DATAFAST_SCRIPT_SRC = "https://datafa.st/js/script.js";

export interface CookieConsentViewProps {
  state: ConsentState;
  websiteId: string;
  domain: string;
  onAccept: () => void;
  onReject: () => void;
  acceptRef?: React.Ref<HTMLButtonElement>;
}

/** Accept and Reject look the same on purpose: neither is the easy one. */
const CHOICE_BUTTON =
  "inline-flex min-h-11 flex-1 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none";

/** The markup, given a state: what the tests render. */
export function CookieConsentView({ state, websiteId, domain, onAccept, onReject, acceptRef }: CookieConsentViewProps) {
  return (
    <>
      {analyticsAllowed(state) ? (
        <Script src={DATAFAST_SCRIPT_SRC} data-website-id={websiteId} data-domain={domain} strategy="afterInteractive" />
      ) : null}
      <section
        id="cookie-consent"
        aria-label="Cookie consent"
        hidden={!state.open}
        className="fixed inset-x-0 bottom-0 z-50 border-t bg-card text-card-foreground shadow-lg pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pt-3 sm:flex-row sm:items-center sm:gap-6">
          <p className="flex-1 text-sm leading-snug text-muted-foreground">
            With your OK, we count visits with an analytics cookie (DataFast). Cookies needed to keep you signed in
            are always on.{" "}
            <Link href="/privacy-policy#cookies" className="text-foreground underline underline-offset-4">
              Cookie details
            </Link>
          </p>
          <div className="flex gap-3">
            <button type="button" className={CHOICE_BUTTON} onClick={onReject}>
              Reject
            </button>
            <button type="button" ref={acceptRef} className={CHOICE_BUTTON} onClick={onAccept}>
              Accept
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

/** Deletes the analytics cookies on this host and its parent domains. */
function clearAnalyticsCookies() {
  try {
    for (const name of analyticsCookieNames(document.cookie)) {
      for (const assignment of expireCookieAssignments(name, window.location.hostname)) {
        document.cookie = assignment;
      }
    }
  } catch {
    // Cookies blocked: there is nothing to delete.
  }
}

export function CookieConsent({ websiteId, domain }: { websiteId: string; domain: string }) {
  const [state, dispatch] = useReducer(consentReducer, INITIAL_CONSENT_STATE);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);

  useEffect(() => {
    dispatch({ type: "loaded", choice: readConsent(browserStorage()) });
    const reopen = () => {
      reopened.current = true;
      dispatch({ type: "reopen" });
    };
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
  }, []);

  // Opened from a "Cookie settings" link: move focus into the banner.
  useEffect(() => {
    if (state.open && reopened.current) {
      reopened.current = false;
      acceptRef.current?.focus();
    }
  }, [state.open]);

  const onAccept = useCallback(() => {
    writeConsent(browserStorage(), "granted");
    dispatch({ type: "accept" });
  }, []);

  const onReject = useCallback(() => {
    const wasGranted = state.choice === "granted";
    writeConsent(browserStorage(), "denied");
    dispatch({ type: "reject" });
    if (wasGranted) {
      // The script is already running in this page: delete its cookies and
      // reload, so nothing more is recorded from here on.
      clearAnalyticsCookies();
      window.location.reload();
    }
  }, [state.choice]);

  return (
    <CookieConsentView
      state={state}
      websiteId={websiteId}
      domain={domain}
      onAccept={onAccept}
      onReject={onReject}
      acceptRef={acceptRef}
    />
  );
}

/** "Cookie settings": reopens the banner. Rendered only where the banner is. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => openCookieSettings()}
    >
      Cookie settings
    </button>
  );
}

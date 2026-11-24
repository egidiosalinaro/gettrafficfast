"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Rocket,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_REFRESH_EVENT,
  ONBOARDING_STEPS,
  nextOnboardingStep,
  onboardingSteps,
  OPTIONAL_ONBOARDING_STEPS,
  type OnboardingStatus,
  type OptionalOnboardingStatus,
} from "@/lib/onboarding";

const MODAL_SEEN_KEY = "gtf-onboarding-modal-seen";
const WIDGET_COLLAPSED_KEY = "gtf-onboarding-widget-collapsed";
const WIDGET_DISMISSED_KEY = "gtf-onboarding-widget-dismissed";

/**
 * Set on <html> while the collapsed pill is on screen. app/globals.css reads
 * it to give a phone's content more room at the bottom (`pb-mobile-chrome`),
 * so the pill above the tab bar never sits on a page's last button.
 */
export const PILL_ATTRIBUTE = "data-getting-started-pill";

/**
 * The widget's starting state when this device has no saved choice:
 * collapsed, on every device. Expanded, the list covers most of a phone and
 * a good part of a laptop on every first visit; the pill is one tap away.
 */
export function initialCollapsed(stored: string | null): boolean {
  return stored === null ? true : stored === "1";
}

/**
 * One onboarding widget for the authenticated shell.
 *
 * It used to be mounted by every section layout, so it remounted — and
 * refetched — on each menu click. The first-visit modal opens on Today,
 * where a sign-in lands (it was Overview, `/dashboard`, which now redirects
 * there).
 */
export function OnboardingHost() {
  const pathname = usePathname();
  const onToday = pathname === "/today" || pathname.startsWith("/today/");
  return <GettingStarted showModal={onToday} />;
}

export function GettingStarted({ showModal = false }: { showModal?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<(OnboardingStatus & Partial<OptionalOnboardingStatus>) | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  // Start hidden until storage is read, so a dismissed widget never flashes.
  const [dismissed, setDismissed] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/status");
      if (!res.ok) return;
      const data = (await res.json()) as OnboardingStatus & Partial<OptionalOnboardingStatus>;
      setStatus(data);

      if (showModal && !data.hasBusiness && !sessionStorage.getItem(MODAL_SEEN_KEY)) {
        sessionStorage.setItem(MODAL_SEEN_KEY, "1");
        setModalOpen(true);
      }
    } catch {
      // Onboarding UI is best-effort; never break the page for it.
    }
  }, [showModal]);

  useEffect(() => {
    // localStorage does not exist on the server: the collapsed state can only
    // be read after mount, which is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only storage
    setCollapsed(initialCollapsed(localStorage.getItem(WIDGET_COLLAPSED_KEY)));
    setDismissed(localStorage.getItem(WIDGET_DISMISSED_KEY) === "1");
    load();

    // Re-check status when another part of the app signals a completed step, and
    // whenever the tab regains focus — so a check flips on without a full reload.
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener(ONBOARDING_REFRESH_EVENT, load);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(ONBOARDING_REFRESH_EVENT, load);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      localStorage.setItem(WIDGET_COLLAPSED_KEY, prev ? "" : "1");
      return !prev;
    });
  }

  // Dismissal is per device and only hides the floating widget: the steps
  // are still the Settings pages they link to, and the first-visit modal
  // still opens for an account with no site.
  function dismiss() {
    localStorage.setItem(WIDGET_DISMISSED_KEY, "1");
    setDismissed(true);
  }

  // The steps this deployment offers (Connect your X account only where posting on X is set up).
  const steps = status ? onboardingSteps(status) : ONBOARDING_STEPS;
  const doneCount = status
    ? steps.filter((s) => status[s.key]).length
    : 0;
  const allDone = doneCount === steps.length;
  const pillShowing = status !== null && !allDone && !dismissed && collapsed;

  useEffect(() => {
    if (!pillShowing) return;
    const root = document.documentElement;
    root.setAttribute(PILL_ATTRIBUTE, "");
    return () => root.removeAttribute(PILL_ATTRIBUTE);
  }, [pillShowing]);

  if (!status || allDone) return null;

  const nextStep = nextOnboardingStep(status);

  return (
    <>
      {modalOpen && (
        <Dialog open onOpenChange={(open) => !open && setModalOpen(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Rocket className="h-5 w-5" />
                <DialogTitle>Let&apos;s set up your site</DialogTitle>
              </div>
              <DialogDescription>
                Two things run here: replies you post on X and other sites, and
                articles for your blog. Start with either. Both begin with your
                business: paste your website URL and we analyze it, so replies
                and articles are written for your niche.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="ghost" onClick={() => setModalOpen(false)}>
                Maybe later
              </Button>
              <Button
                onClick={() => {
                  setModalOpen(false);
                  router.push("/settings/business");
                }}
              >
                Set up my business →
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/*
        Phone: full width, sitting just above the bottom tab bar (56px plus
        the home-indicator inset). Desktop: the floating card beside the
        sidebar, as before.
      */}
      {!dismissed && (
        <div className="fixed inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 md:inset-x-auto md:bottom-4 md:left-52">
          {collapsed ? (
            <div className="flex items-center rounded-full border border-border bg-background shadow-lg">
              <button
                type="button"
                onClick={toggleCollapsed}
                className="flex min-h-[44px] flex-1 items-center gap-2 rounded-l-full pl-4 pr-2 text-sm font-medium hover:bg-muted transition-colors md:min-h-0 md:py-2"
              >
                <Rocket className="h-4 w-4" />
                <span>Getting started</span>
                <span className="text-xs text-muted-foreground">
                  {doneCount}/{steps.length}
                </span>
              </button>
              <DismissButton onClick={dismiss} />
            </div>
          ) : (
            <div className="w-full md:w-80 max-h-[60vh] flex flex-col rounded-xl border border-border bg-background shadow-xl overflow-hidden">
              <div className="flex items-center border-b border-border">
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  className="flex min-h-[44px] flex-1 items-center justify-between pl-4 pr-2 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Rocket className="h-4 w-4" />
                    <span className="text-sm font-semibold">Getting started</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {doneCount}/{steps.length} done
                    </span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
                <DismissButton onClick={dismiss} />
              </div>
              <div className="h-1 bg-muted">
                <div
                  className="h-1 bg-primary transition-all"
                  style={{ width: `${(doneCount / steps.length) * 100}%` }}
                />
              </div>
              <ul className="p-2 overflow-y-auto">
                {steps.map((step) => {
                  const done = status[step.key];
                  const isNext = step.key === nextStep?.key;
                  // A step that starts a sign-in elsewhere (X's consent screen) is a plain link: never prefetched.
                  const StepLink = step.href.startsWith("/api/") ? "a" : Link;
                  return (
                    <li key={step.key}>
                      <StepLink
                        href={step.href}
                        className={cn(
                          "flex items-start gap-3 rounded-lg px-2 py-2 transition-colors",
                          done
                            ? "opacity-60"
                            : "hover:bg-muted",
                          isNext && "bg-muted/60"
                        )}
                      >
                        {done ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <p
                            className={cn(
                              "text-sm font-medium leading-tight",
                              done && "line-through"
                            )}
                          >
                            {step.label}
                          </p>
                          {!done && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {step.description}
                            </p>
                          )}
                        </div>
                      </StepLink>
                    </li>
                  );
                })}
                {OPTIONAL_ONBOARDING_STEPS.filter((step) => !status[step.key]).map((step) => (
                  <li key={step.key} className="mt-1 border-t border-border pt-1">
                    <Link
                      href={step.href}
                      className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted"
                    >
                      <Circle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" strokeDasharray="3 3" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-tight">
                          {step.label} <span className="text-xs font-normal text-muted-foreground">optional</span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Hide getting started"
      title="Hide getting started"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors md:h-9 md:w-9"
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

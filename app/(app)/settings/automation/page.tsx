"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AutomationSettings, DEFAULT_AUTOMATION_SETTINGS } from "@/lib/automation/settings";
import type { AutopilotRunView } from "@/lib/automation/run-status";
import { refreshOnboarding } from "@/lib/onboarding";
import { pluralize } from "@/lib/utils";
import { MediaSettingsForm } from "@/components/settings/media-settings-form";

/**
 * Autopilot.
 *
 * The page says what it does in plain words, because it publishes on the
 * customer's own site. Since 2026-11-24 Autopilot, Push page 3 and images
 * are on by default: the switches are there to turn them off, and the page
 * never asks the person to turn them on. The buffer is presented as what it
 * really is: how far ahead the calendar is filled, which is also how long
 * they have to cancel an article before it is written.
 *
 * Images & video (`/settings/generation` until 2026-11-14) is the second
 * half of this page, under `#images`: whether every article Autopilot (or a
 * person) has written also gets images is part of the same choice. Its old
 * path redirects here (lib/legacy-redirects.ts). The two halves save
 * separately, each to its own route and tool (`update_automation_settings`,
 * `update_media_settings`).
 */

export default function AutomationPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-10 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Autopilot</h1>
        <p className="text-muted-foreground">
          What GetTrafficFast does on its own for this site: which topics it writes about, how far ahead, and the
          images each article gets.
        </p>
      </div>
      <AutopilotSettings />
      <section id="images" aria-labelledby="images-heading" className="scroll-mt-4 space-y-4">
        <div>
          <h2 id="images-heading" className="text-xl font-semibold">
            Images and video
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Whether articles get generated images and a relevant YouTube video when they are written, and how the
            images look.
          </p>
        </div>
        <MediaSettingsForm />
      </section>
    </div>
  );
}

function AutopilotSettings() {
  const [settings, setSettings] = useState<AutomationSettings>(DEFAULT_AUTOMATION_SETTINGS);
  const [availableKeywords, setAvailableKeywords] = useState(0);
  const [scheduledArticles, setScheduledArticles] = useState(0);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [run, setRun] = useState<AutopilotRunView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/business/automation-settings");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load settings");
        setSettings(data.settings);
        setAvailableKeywords(data.availableKeywords ?? 0);
        setScheduledArticles(data.scheduledArticles ?? 0);
        setSiteName(data.siteName ?? null);
        setRun(data.autopilotRun ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load settings");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // Arriving at #images (a link to the section, the old /settings/generation): scroll there once this half has its height. The
  // phone's scrolling area starts every page at its top, so the browser's own
  // jump to the anchor does not hold.
  useEffect(() => {
    if (!isLoading && window.location.hash === "#images") {
      document.getElementById("images")?.scrollIntoView({ block: "start" });
    }
  }, [isLoading]);

  const set = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/business/automation-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save");
      setSaved(true);
      refreshOnboarding();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <section aria-labelledby="autopilot-heading" className="space-y-6">
      <div>
        <h2 id="autopilot-heading" className="text-xl font-semibold">
          Topics and schedule
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Keeps the calendar filled so publishing never stops while you are away,
          and tops up your keywords before they run out.
          {siteName ? ` For ${siteName} only: each of your sites has its own Autopilot setting.` : ""}
        </p>
      </div>

      {run && (
        <div
          role="status"
          className={
            run.state === "stalled" || run.state === "skipped"
              ? "rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
              : "rounded-md border border-foreground/10 p-3 text-sm text-muted-foreground"
          }
        >
          <p>{run.message}</p>
          {run.lastRun && run.lastRun.reasons.length > 1 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {run.lastRun.reasons
                .filter((reason) => reason.message !== run.message)
                .map((reason) => (
                  <li key={reason.code}>{reason.message}</li>
                ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-foreground/10 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="text-sm font-medium">Keep the calendar filled</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              On for every site. GetTrafficFast schedules articles and publishes
              them on your site on their day, without asking each time. Untick it
              to schedule every article yourself.
            </span>
          </span>
        </label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="buffer-days">Keep the calendar filled for</Label>
        <div className="flex items-center gap-3">
          <input
            id="buffer-days"
            type="range"
            min={1}
            max={30}
            value={settings.bufferDays}
            onChange={(e) => set("bufferDays", Number(e.target.value))}
            className="w-64"
          />
          <span className="text-sm tabular-nums">{pluralize(settings.bufferDays, "day")}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          This is also your review window: an article appears on the calendar
          this many days before it is written, so you can remove it first.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="keyword-floor">Top up keywords when fewer than</Label>
        <div className="flex items-center gap-3">
          <input
            id="keyword-floor"
            type="range"
            min={0}
            max={50}
            value={settings.keywordFloor}
            onChange={(e) => set("keywordFloor", Number(e.target.value))}
            className="w-64"
          />
          <span className="text-sm tabular-nums">{settings.keywordFloor} left</span>
        </div>
        <p className="text-xs text-muted-foreground">
          New keywords are generated from your business profile only when the
          pool drops below this, and never more than {settings.maxKeywordsPerRun} at a time.
        </p>
      </div>

      <div className="rounded-lg border border-foreground/10 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.backLinks}
            onChange={(e) => set("backLinks", e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="text-sm font-medium">Link older articles to new ones</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              On by default, with or without autopilot. When an article is published, up to 3 older
              articles on the same topic get one link to it and are updated on your site. A link is
              added only where the older article already has words that fit; otherwise it is left
              as it was. Included in your plan.
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-lg border border-foreground/10 p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.pushPage3}
            onChange={(e) => set("pushPage3", e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="text-sm font-medium">Push articles stuck on pages 2 to 4</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              On for every site, with or without autopilot. Once a week, up to 3 articles
              that Google shows at positions 11 to 40 (Search Console needed) get a link from your best
              related pages, with the search they are shown for as the link text, and a tighter search
              title and description. The headline and the address stay. If your site takes updates,
              they are applied; otherwise they wait for you in Today. Each push is measured 14 and 28
              days later in Growth.
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4 text-sm">
        <div className="font-medium">Right now</div>
        <div className="mt-1 text-muted-foreground">
          {scheduledArticles} article{scheduledArticles === 1 ? "" : "s"} scheduled ahead,{" "}
          {availableKeywords} keyword{availableKeywords === 1 ? "" : "s"} unused.
          {settings.enabled
            ? " Autopilot runs every morning."
            : " Autopilot is off for this site: only the articles you schedule are written."}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={isSaving} className="h-11 md:h-9">
          {isSaving ? "Saving..." : "Save"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </section>
  );
}

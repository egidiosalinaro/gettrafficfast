"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, MessageSquareText, Target, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ABOUT_YOU_MAX,
  ARTICLE_FACTS_MAX,
  DAILY_REPLY_GOAL_MAX,
  DEFAULT_VOICE_SETTINGS,
  INSTRUCTIONS_MAX,
  VOICE_PERSONS,
  VOICE_PRESETS,
  type VoiceSettings,
} from "@/lib/voice/settings";
import { aboutYouFacts, confirmationLabel, quoteShort, staleFacts, type FactConfirmations } from "@/lib/voice/staleness";

/** The goal as typed: a whole number from 1 to the maximum, or none. An empty or unreadable field is no goal. */
export function goalFromInput(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, DAILY_REPLY_GOAL_MAX);
}

/**
 * Under About you: one quiet line for each sentence whose date is more than
 * 30 days old, "Dated October 2026 (last month): still true?", with the
 * sentence quoted short. Read from the text as it stands in the box, so the
 * line goes when the sentence is brought up to date. It asks; it never edits
 * the text and never stops a save. A draft states such a fact as of its
 * date, never as current (lib/voice/staleness.ts).
 *
 * A fact confirmed on Today ("Still true", `confirmedFacts`) is not asked
 * about for 30 days; meanwhile it gets one small line, "confirmed Nov 14",
 * on one line. The confirmation is for the words as they were: edit the
 * sentence in the box and its line goes, and it is asked about again.
 */
export function StaleFactLines({
  aboutYou,
  now,
  confirmations = {},
}: {
  aboutYou: string;
  now: Date;
  confirmations?: FactConfirmations;
}) {
  const stale = staleFacts(aboutYou, now, { confirmations });
  const confirmed = aboutYouFacts(aboutYou, now, { confirmations }).filter(
    (fact) => !fact.stale && fact.date && fact.confirmedOn && fact.confirmedOn > fact.date.iso
  );
  if (stale.length === 0 && confirmed.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Dated facts">
      {stale.map((fact) => (
        <li key={`${fact.date}:${fact.sentence}`} className="text-xs leading-snug text-muted-foreground">
          {fact.line} <span className="italic">&ldquo;{quoteShort(fact.sentence)}&rdquo;</span>
        </li>
      ))}
      {confirmed.map((fact) => (
        <li key={`confirmed:${fact.sentence}`} className="truncate text-xs leading-snug text-muted-foreground/80">
          confirmed {shortDay(fact.confirmedOn as string, now)}{" "}
          <span className="italic">&ldquo;{quoteShort(fact.sentence, 48)}&rdquo;</span>
        </li>
      ))}
    </ul>
  );
}

/** "Nov 14" this year, "Nov 14, 2025" another. */
function shortDay(iso: string, now: Date): string {
  const label = confirmationLabel(iso);
  return iso.startsWith(String(now.getUTCFullYear())) ? label.replace(/, \d{4}$/, "") : label;
}

/** "2,000": the limit as the counter and the hint write it. */
const aboutYouLimit = ABOUT_YOU_MAX.toLocaleString("en-US");

/**
 * The About you box: the hint, the field held to `ABOUT_YOU_MAX` (2,000
 * characters since 12 November 2026, when 400 left room for one fact and
 * drafts kept repeating it), the count, and the stale lines.
 */
export function AboutYouField({
  value,
  onChange,
  now,
  confirmations = {},
}: {
  value: string;
  onChange: (value: string) => void;
  now: Date;
  confirmations?: FactConfirmations;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="voice-about-you">About you</Label>
      <p id="voice-about-you-hint" className="text-sm text-muted-foreground">
        Several kinds of facts give a reply something to say that fits the post: numbers you measured, what
        you are building, what you feel and believe about building, your situation, opinions you hold. Only
        true things, the way you could say them out loud in the thread yourself. A reply uses one only where
        it fits, and not the same one every time. Put a date on a number (&ldquo;in October 2026&rdquo;): a
        draft then says when it was true, and after 30 days this page asks whether it still is.
      </p>
      <Textarea
        id="voice-about-you"
        aria-describedby="voice-about-you-hint"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={ABOUT_YOU_MAX}
        rows={8}
        placeholder="For example: I run a two-person bakery and use the product for our weekly recipe posts. 40 orders a week since September 2026. I think a small menu beats a big one. I bake because I like seeing people come back."
      />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <StaleFactLines aboutYou={value} now={now} confirmations={confirmations} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {value.length.toLocaleString("en-US")}/{aboutYouLimit}
        </span>
      </div>
    </div>
  );
}

/** "2,000": the Facts for articles limit as the counter writes it. */
const articleFactsLimit = ARTICLE_FACTS_MAX.toLocaleString("en-US");

/**
 * The Facts for articles box (12 November 2026): what a public article may
 * state about the writer and the business. Separate from About you, which
 * replies read: a candid early number belongs in a reply, not on the blog.
 */
export function ArticleFactsField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="voice-article-facts">Facts for articles (optional)</Label>
      <p id="voice-article-facts-hint" className="text-sm text-muted-foreground">
        True things your articles may state about you and your business. Leave out what you would not want on
        your public blog. Articles never read About you; with this empty they state no results or numbers of
        your own, and speak in the first person only about method and opinion.
      </p>
      <Textarea
        id="voice-article-facts"
        aria-describedby="voice-article-facts-hint"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={ARTICLE_FACTS_MAX}
        rows={5}
        placeholder="For example: I have run a two-person bakery since 2019. We publish a recipe every week."
      />
      <div className="flex justify-end">
        <span className="shrink-0 text-xs text-muted-foreground">
          {value.length.toLocaleString("en-US")}/{articleFactsLimit}
        </span>
      </div>
    </div>
  );
}

/**
 * Tone of voice.
 *
 * Two things only the business can answer: how it sounds, and what is true
 * about the person who will paste the reply. The second is the one that
 * keeps drafts honest — drafts speak as someone who uses the product, and
 * with it empty there is nothing honest to say, so none is written.
 *
 * The site's X account is stored with the voice (`xHandle`) but edited in
 * Settings → Connections and on Today (XHandleField). This form still sends
 * the whole object it loaded, that value included, unchanged.
 */
export function VoiceSettingsForm() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [hasBusiness, setHasBusiness] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // The day the page was opened: what "more than 30 days old" is measured from.
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/business/voice-settings");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setSettings(data.settings);
        setHasBusiness(data.hasBusiness);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      const res = await fetch("/api/business/voice-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to save settings" });
        return;
      }
      setSettings(data.settings);
      setMessage({ type: "success", text: "Voice saved. The next draft you generate uses it." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {message && (
        <div
          className={cn(
            "flex items-center gap-2 p-4 rounded-md border",
            message.type === "success"
              ? "bg-green-50 dark:bg-green-950/40 text-green-900 dark:text-green-100 border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100 border-red-200 dark:border-red-800"
          )}
        >
          {message.type === "success" ? <CheckCircle2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {!hasBusiness && (
        <div className="flex items-center gap-2 p-4 rounded-md bg-yellow-50 dark:bg-yellow-950/40 border border-yellow-200 dark:border-yellow-800 text-sm text-yellow-900 dark:text-yellow-100">
          <AlertCircle className="h-5 w-5 shrink-0" />
          Set up your business first (Settings → Business): the voice is saved per business.
        </div>
      )}

      <Card className="p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <MessageSquareText className="h-5 w-5" />
            <h2 className="text-xl font-semibold">How you sound</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            A draft is written like a person who happens to be in the thread, whatever you choose
            here. This decides which person.
          </p>
        </div>

        <div className="space-y-3">
          <Label>Tone</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {VOICE_PRESETS.map((preset) => {
              const isSelected = settings.preset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => set("preset", preset.value)}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex h-full flex-col rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-foreground/40"
                  )}
                >
                  <div className="text-sm font-medium">{preset.label}</div>
                  <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{preset.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <Label>Who is speaking</Label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {VOICE_PERSONS.map((person) => {
              const isSelected = settings.person === person.value;
              return (
                <button
                  key={person.value}
                  type="button"
                  onClick={() => set("person", person.value)}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex h-full flex-col rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-foreground/40"
                  )}
                >
                  <div className="text-sm font-medium">{person.label}</div>
                  <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{person.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="voice-instructions">Your own notes</Label>
          <Textarea
            id="voice-instructions"
            value={settings.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            maxLength={INSTRUCTIONS_MAX}
            rows={3}
            placeholder="For example: short sentences, no exclamation marks, and never the word 'synergy'."
          />
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              How you write, in your words. Things you always say, things you never say.
            </p>
            <span className="shrink-0 text-xs text-muted-foreground">
              {settings.instructions.length}/{INSTRUCTIONS_MAX}
            </span>
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <UserRound className="h-5 w-5" />
            <h2 className="text-xl font-semibold">About you</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            The true facts a draft may say about you, and the only personal experience it may claim.
            Replies never name your product, so this is not a mention to paste; it is what you can speak
            from. With it empty, no draft is written: there would be nothing honest to say.
          </p>
        </div>
        <AboutYouField
          value={settings.aboutYou}
          onChange={(value) => set("aboutYou", value)}
          now={now}
          confirmations={settings.confirmedFacts}
        />
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="h-5 w-5" />
            <h2 className="text-xl font-semibold">Facts for articles</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            What your published articles may say about you. Replies keep using About you.
          </p>
        </div>
        <ArticleFactsField value={settings.articleFacts} onChange={(value) => set("articleFacts", value)} />
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Target className="h-5 w-5" />
            <h2 className="text-xl font-semibold">Daily goal</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            How many replies you mean to post a day. Replies shows it as &ldquo;2 of 5 today&rdquo;. Leave it
            empty for a plain count.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="voice-daily-goal">Replies a day (optional)</Label>
          <input
            id="voice-daily-goal"
            type="number"
            inputMode="numeric"
            min={1}
            max={DAILY_REPLY_GOAL_MAX}
            value={settings.dailyReplyGoal ?? ""}
            onChange={(e) => set("dailyReplyGoal", goalFromInput(e.target.value))}
            placeholder="No goal"
            className="h-11 w-32 rounded-md border border-input bg-background px-3 text-base"
          />
        </div>
      </Card>

      <Button type="submit" size="lg" disabled={saving || !hasBusiness} className="w-full sm:w-auto">
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          "Save Changes"
        )}
      </Button>
    </form>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { AeoQueryRecord } from "@/lib/visibility/read";
import { GROWTH_AI_PATH, questionPath } from "@/lib/growth/routes";
import { pluralize } from "@/lib/utils";
import {
  AEO_CADENCES,
  AEO_INTENTS,
  DEFAULT_AEO_SETTINGS,
  MAX_NEW_TARGETS_PER_RUN,
  MAX_QUERIES_PER_RUN,
  type AeoSettings,
} from "@/lib/visibility/settings";

/**
 * AI Visibility configuration: the prompt set, what counts as "us", which
 * engines to ask and how often. The page states the size of a run in probes
 * per run. The cadence is weekly by default since 2026-11-24 (the probes are
 * the platform's, the engines the deployment's choice); Off is the person's
 * opt-out. The customer reads what a run does, not what it costs us.
 */

/** Phones get 44px targets; from md up the controls keep their compact size. */
const TOUCH = "min-h-[44px] md:min-h-0";

interface SettingsPayload {
  settings: AeoSettings;
  identity: { domains: string[]; brandNames: string[] };
  configuredEngines: string[];
  business: { name: string | null; websiteUrl: string | null };
}

const CADENCE_LABEL: Record<(typeof AEO_CADENCES)[number], string> = {
  off: "Off: run by hand only",
  weekly: "Weekly",
  monthly: "Monthly",
};

export default function VisibilitySettingsPage() {
  const [settings, setSettings] = useState<AeoSettings>(DEFAULT_AEO_SETTINGS);
  const [brandText, setBrandText] = useState("");
  const [domainText, setDomainText] = useState("");
  const [meta, setMeta] = useState<SettingsPayload | null>(null);
  const [queries, setQueries] = useState<AeoQueryRecord[]>([]);
  const [newQueries, setNewQueries] = useState("");
  const [newCluster, setNewCluster] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<
    Array<{ query: string; cluster: string | null; intent: AeoQueryRecord["intent"]; why: string; selected: boolean }>
  >([]);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadQueries = useCallback(async () => {
    const response = await fetch("/api/visibility/queries", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load prompts");
    setQueries(payload.queries as AeoQueryRecord[]);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/visibility/settings", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load settings");
        const data = payload as SettingsPayload;
        setMeta(data);
        setSettings(data.settings);
        setBrandText(data.settings.brandNames.join(", "));
        setDomainText(data.settings.domains.join(", "));
        await loadQueries();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load settings");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [loadQueries]);

  const splitList = (value: string) =>
    value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean);

  const save = async () => {
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: AeoSettings = {
        ...settings,
        brandNames: splitList(brandText).slice(0, 10),
        domains: splitList(domainText).slice(0, 10),
      };
      const response = await fetch("/api/visibility/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save");
      setSettings(payload.settings);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setIsSaving(false);
    }
  };

  const addQueries = async () => {
    const lines = splitList(newQueries.replace(/,/g, "\n"));
    if (lines.length === 0) return;
    setIsAdding(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/visibility/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: lines.map((query) => ({ query, cluster: newCluster.trim() || null })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add prompts");
      setNotice(`${payload.added} added${payload.duplicates ? `, ${payload.duplicates} already in the set` : ""}.`);
      setNewQueries("");
      await loadQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add prompts");
    } finally {
      setIsAdding(false);
    }
  };

  const importKeywords = async () => {
    setIsAdding(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/visibility/queries/import", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not import keywords");
      setNotice(
        `${payload.added} imported from your keywords${payload.duplicates ? `, ${payload.duplicates} already there` : ""}. Keywords are asked verbatim; rewrite the ones a person would phrase as a question.`
      );
      await loadQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import keywords");
    } finally {
      setIsAdding(false);
    }
  };

  const suggestPrompts = async () => {
    setIsSuggesting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/visibility/queries/suggest", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not suggest prompts");
      const prompts = (payload.prompts as Array<{
        query: string;
        cluster: string | null;
        intent: AeoQueryRecord["intent"];
        why: string;
      }>) ?? [];
      if (prompts.length === 0) {
        setSuggestions([]);
        setNotice(
          "Nothing new to suggest. The current set already covers what the model would write, or the business profile is too thin."
        );
        return;
      }
      setSuggestions(prompts.map((p) => ({ ...p, selected: true })));
      setNotice(
        `${prompts.length} suggested. Uncheck any you do not want, edit the wording, then add them. They are not in the set until you do.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not suggest prompts");
    } finally {
      setIsSuggesting(false);
    }
  };

  const addSuggested = async () => {
    const chosen = suggestions.filter((s) => s.selected && s.query.trim());
    if (chosen.length === 0) return;
    setIsAdding(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/visibility/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "suggested",
          queries: chosen.map((s) => ({
            query: s.query,
            cluster: s.cluster,
            intent: s.intent,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add prompts");
      setNotice(
        `${payload.added} added${payload.duplicates ? `, ${payload.duplicates} already in the set` : ""}. Disable generic keyword imports if the next run should only ask these.`
      );
      setSuggestions([]);
      await loadQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add prompts");
    } finally {
      setIsAdding(false);
    }
  };

  const patchQuery = async (id: string, patch: Partial<Pick<AeoQueryRecord, "cluster" | "intent" | "enabled" | "query">>) => {
    setError(null);
    const previous = queries;
    setQueries((current) => current.map((q) => (q.id === id ? { ...q, ...patch } : q)));
    try {
      const response = await fetch("/api/visibility/queries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not update the prompt");
      setQueries((current) => current.map((q) => (q.id === id ? (payload.query as AeoQueryRecord) : q)));
    } catch (err) {
      setQueries(previous);
      setError(err instanceof Error ? err.message : "Could not update the prompt");
    }
  };

  const removeQuery = async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/visibility/queries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not remove the prompt");
      setQueries((current) => current.filter((q) => q.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the prompt");
    }
  };

  const enabledCount = queries.filter((q) => q.enabled).length;
  const activeEngines = useMemo(() => {
    const configured = meta?.configuredEngines ?? [];
    return settings.engines.length === 0 ? configured : configured.filter((e) => settings.engines.includes(e));
  }, [meta, settings.engines]);
  const probesPerRun = Math.min(enabledCount, settings.maxQueriesPerRun) * activeEngines.length;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link href={GROWTH_AI_PATH} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0">
          <ArrowLeft className="h-4 w-4" /> AI answers
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The questions to ask, what counts as you being cited, which engines to ask and how often.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
      {notice && (
        <div className="rounded-md border border-foreground/10 bg-muted/20 p-3 text-sm text-muted-foreground">{notice}</div>
      )}

      {/* ── Prompts ─────────────────────────────────────────────────────── */}
      <section id="prompts" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Prompts ({queries.length}, {enabledCount} enabled)</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Phrase them the way a customer would ask an AI assistant. Uncheck a prompt to exclude it from runs
            without losing its history, for instance when it is too generic or not commercial. Suggest writes a
            short list from the business profile; you still pick which ones to add.
          </p>
        </div>

        <div className="rounded-lg border border-foreground/10 p-3 space-y-2">
          <Label htmlFor="new-queries">Add prompts, one per line</Label>
          <textarea
            id="new-queries"
            value={newQueries}
            onChange={(e) => setNewQueries(e.target.value)}
            rows={3}
            placeholder="One prompt per line"
            className="w-full rounded-md border border-foreground/10 bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newCluster}
              onChange={(e) => setNewCluster(e.target.value)}
              placeholder="cluster (optional)"
              className={`rounded-md border border-foreground/10 bg-background px-3 py-1.5 text-sm ${TOUCH}`}
              maxLength={60}
            />
            <Button type="button" size="sm" onClick={addQueries} disabled={isAdding || isSuggesting || !newQueries.trim()} className={TOUCH}>
              {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={suggestPrompts} disabled={isAdding || isSuggesting} className={TOUCH}>
              {isSuggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Suggest prompts
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={importKeywords} disabled={isAdding || isSuggesting} className={TOUCH}>
              Import from keywords
            </Button>
          </div>
        </div>

        {suggestions.length > 0 && (
          <div className="rounded-lg border border-foreground/10 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Suggested, not yet in the set ({suggestions.filter((s) => s.selected).length} selected)
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setSuggestions([])}>
                  Dismiss
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={addSuggested}
                  disabled={isAdding || !suggestions.some((s) => s.selected)}
                >
                  {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add selected
                </Button>
              </div>
            </div>
            <ul className="space-y-2">
              {suggestions.map((item, index) => (
                <li key={`${item.query}-${index}`} className="rounded-md border border-foreground/10 p-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1.5"
                      checked={item.selected}
                      onChange={(e) =>
                        setSuggestions((current) =>
                          current.map((s, i) => (i === index ? { ...s, selected: e.target.checked } : s))
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <input
                        value={item.query}
                        onChange={(e) =>
                          setSuggestions((current) =>
                            current.map((s, i) => (i === index ? { ...s, query: e.target.value } : s))
                          )
                        }
                        className="w-full rounded-md border border-foreground/10 bg-background px-2 py-1 text-sm"
                      />
                      <span className="block text-xs text-muted-foreground">{item.why}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {item.cluster ?? "no cluster"} · {item.intent ?? "no intent"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {queries.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">On</th>
                  <th className="px-3 py-2 text-left font-medium">Prompt</th>
                  <th className="px-3 py-2 text-left font-medium">Cluster</th>
                  <th className="px-3 py-2 text-left font-medium">Intent</th>
                  <th className="px-3 py-2 text-left font-medium">Source</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {queries.map((q) => (
                  <tr key={q.id} className={`border-t border-foreground/10 ${q.enabled ? "" : "opacity-60"}`}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={q.enabled}
                        onChange={(e) => patchQuery(q.id, { enabled: e.target.checked })}
                        aria-label={q.enabled ? "Exclude from runs" : "Include in runs"}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Link href={questionPath(q.id)} className="hover:underline">{q.query}</Link>
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        defaultValue={q.cluster ?? ""}
                        placeholder="none"
                        maxLength={60}
                        className="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs hover:border-foreground/10 focus:border-foreground/20"
                        onBlur={(e) => {
                          const value = e.target.value.trim() || null;
                          if (value !== (q.cluster ?? null)) patchQuery(q.id, { cluster: value });
                        }}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        value={q.intent ?? ""}
                        onChange={(e) => patchQuery(q.id, { intent: (e.target.value || null) as AeoQueryRecord["intent"] })}
                        className="rounded border border-transparent bg-transparent px-1 py-0.5 text-xs hover:border-foreground/10"
                      >
                        <option value="">none</option>
                        {AEO_INTENTS.map((intent) => (
                          <option key={intent} value={intent}>{intent}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{q.source}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => removeQuery(q.id)}
                        className="-m-2 inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-red-600 dark:hover:text-red-400 md:m-0 md:h-auto md:w-auto"
                        aria-label="Remove prompt"
                        title="Remove from the set. Past probes are kept."
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Identity ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">What counts as you</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your site {meta?.identity.domains[0] ? <span className="font-medium text-foreground">{meta.identity.domains[0]}</span> : null} always
            counts, subdomains included. Add other domains you own and the spellings an engine might use for your brand.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="brands">Brand names (comma separated)</Label>
            <input
              id="brands"
              value={brandText}
              onChange={(e) => { setBrandText(e.target.value); setSaved(false); }}
              placeholder={meta?.business.name ?? "Brand, Brand Inc"}
              className="w-full rounded-md border border-foreground/10 bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              {meta?.business.name ? `"${meta.business.name}" is always included.` : ""} Very short or common words are not
              counted as mentions, to avoid false positives.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="domains">Extra domains (comma separated)</Label>
            <input
              id="domains"
              value={domainText}
              onChange={(e) => { setDomainText(e.target.value); setSaved(false); }}
              placeholder="blog.example.com, example.io"
              className="w-full rounded-md border border-foreground/10 bg-background px-3 py-1.5 text-sm"
            />
          </div>
        </div>
      </section>

      {/* ── Engines ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Engines</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Only the answer engines GetTrafficFast asks today can be selected. Rates are always shown per engine;
            they are never averaged.
          </p>
        </div>
        {(meta?.configuredEngines.length ?? 0) === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            No answer engine is enabled yet. Runs cannot start until one is.
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {meta!.configuredEngines.map((engine) => {
              const checked = settings.engines.length === 0 || settings.engines.includes(engine);
              return (
                <label key={engine} className={`flex items-center gap-2 rounded-md border border-foreground/10 px-3 py-1.5 text-sm ${TOUCH}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const all = meta!.configuredEngines;
                      const current = settings.engines.length === 0 ? all : settings.engines;
                      const next = e.target.checked
                        ? [...new Set([...current, engine])]
                        : current.filter((name) => name !== engine);
                      setSettings((s) => ({ ...s, engines: next.length === all.length ? [] : next }));
                      setSaved(false);
                    }}
                  />
                  {engine}
                </label>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Cadence ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Cadence</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Weekly unless you choose otherwise; Off asks only when you press Run now. With the current set a run is{" "}
            <span className="font-medium text-foreground">{pluralize(probesPerRun, "probe")}</span> (
            {pluralize(Math.min(enabledCount, settings.maxQueriesPerRun), "prompt")} ×{" "}
            {pluralize(activeEngines.length, "engine")}).
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {AEO_CADENCES.map((cadence) => (
            <label key={cadence} className={`flex items-center gap-2 rounded-md border border-foreground/10 px-3 py-1.5 text-sm ${TOUCH}`}>
              <input
                type="radio"
                name="cadence"
                checked={settings.cadence === cadence}
                onChange={() => { setSettings((s) => ({ ...s, cadence })); setSaved(false); }}
              />
              {CADENCE_LABEL[cadence]}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="max-queries">Prompts per run, at most</Label>
          <input
            id="max-queries"
            type="number"
            min={1}
            max={MAX_QUERIES_PER_RUN}
            value={settings.maxQueriesPerRun}
            onChange={(e) => {
              const value = Math.max(1, Math.min(MAX_QUERIES_PER_RUN, Number(e.target.value) || 1));
              setSettings((s) => ({ ...s, maxQueriesPerRun: value }));
              setSaved(false);
            }}
            className="w-20 rounded-md border border-foreground/10 bg-background px-2 py-1 text-sm"
          />
          <span className="text-xs text-muted-foreground">oldest prompts first; a hard ceiling per run.</span>
        </div>
      </section>

      {/* ── From sources to Replies ─────────────────────────────────────── */}
      <section id="places" className="scroll-mt-20 space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Places to reply</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            On by default. Each run ends by sending to Replies the threads, posts and list articles its answers cited
            when they did not cite you, at most {MAX_NEW_TARGETS_PER_RUN} new ones a run. Finding them is free and asks no
            engine or model again; nothing is drafted until you ask, and a draft is a paid draft like any other.
            Citations are sampled answers, one per prompt and engine. Nothing is posted or sent for you.
          </p>
        </div>
        <label className={`flex items-center gap-2 text-sm ${TOUCH}`}>
          <input
            type="checkbox"
            checked={settings.placesFromSources}
            onChange={(e) => {
              const placesFromSources = e.target.checked;
              setSettings((s) => ({ ...s, placesFromSources }));
              setSaved(false);
            }}
          />
          After each run, turn cited sources into reply targets
        </label>
      </section>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={isSaving}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save configuration
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

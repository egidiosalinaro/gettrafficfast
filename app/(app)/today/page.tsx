"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, Search, X } from "lucide-react";
import { UI_LOCALE } from "@/lib/format";
import {
  DRAFT_POLL_MS,
  DRAFT_WAIT_MS,
  draftFinishedMessage,
  draftGaveUpWaitingMessage,
  draftStillWaitingMessage,
  draftWaitMessage,
  type DraftFailureKind,
} from "@/lib/placements/draft-progress";
import {
  AI_CITED_FILTER,
  inboxWriterUseRecorded,
  type InboxPayload,
  type PlacementDraftRecord,
  type PlacementTargetRecord,
} from "@/lib/placements/read";
import {
  addedToast,
  archiveReason,
  groupOf,
  inView,
  isTodayViewId,
  leftToast,
  nextOpenId,
  stepOpenId,
  todayViewList,
  viewStatus,
  type InboxGroup,
  type InboxViewId,
  type TodayViewId,
} from "@/lib/placements/inbox-view";
import type { LinkMatch } from "@/lib/placements/link-match";
import { addSummary, type AddAttempt } from "@/lib/placements/paste";
import { browserTimeZone, todayLinks } from "@/lib/placements/today";
import { missingPublishedLink } from "@/lib/placements/published-url";
import type { AddOutcome } from "@/lib/placements/manual";
import { isHumanWritten } from "@/lib/placements/workflow";
import { describeDiscoverySources } from "@/lib/placements/sources";
import { lastSearchText, nextSearchLabel } from "@/lib/placements/discovery-progress";
import type { AlsoTodayItem } from "@/lib/today/also-today";
import { AddPostForm, type AddReport } from "@/components/placements/add-post-form";
import { RepliesLoading } from "@/components/placements/replies-loading";
import { LinkBox, PasteLinkButton, PostedItem, type LinkBoxResult } from "@/components/placements/posted-item";
import { GroupHeading, OpenInPlace, QueueRow, dayCountFallback } from "@/components/placements/queue";
import { AlsoToday } from "@/components/today/also-today";
import { ProgressCard } from "@/components/today/progress-card";
import { ViewTabs } from "@/components/today/view-tabs";
import { TodaySheet } from "@/components/placements/today-sheet";
import { ReplyItem, type ItemActions } from "@/components/placements/reply-item";
import { CloseItem } from "@/components/placements/post-preview";
import type { AddFactResult, RemoveFactResult } from "@/components/placements/confirm-fact";
import { LinkSheet, findingToast, linkSheetToast, type LinkSheetOutcome } from "@/components/placements/link-sheet";
import { linkFinding } from "@/lib/placements/reply-link";
import {
  shortcutFor,
  withSavedDraft,
  type CorrectionResult,
  type PromoteNoteResult,
  type SaveDraftResult,
} from "@/components/placements/reply-logic";
import { rowSwipeActions, rowSwipes, type SwipeAction } from "@/components/placements/swipe";
import { Toast, useToast } from "@/components/placements/toast";
import { MoreMenu, Problem, TWO_PANES, useMediaQuery } from "@/components/placements/ui";
import { cn } from "@/lib/utils";

/**
 * Today (`/today`, 2026-11-14): the first screen of the day, Overview and
 * Replies in one (the Placements subsystem, `docs/PLACEMENTS.md`, "Today").
 *
 * From the top: "3 of 5 replies" toward the daily goal, with where today's
 * links stand (the card opens the Today sheet); three tabs, To do, Posted
 * and Archive (`TODAY_VIEWS`), in place of the eleven lists of the old
 * filter; the open reply; "Also today", what else needs a gesture today
 * (lib/today/also-today.ts); then the next replies as rows that swipe.
 *
 * A queue with one item open (2026-11-10). The daily loop, mostly on a
 * phone: paste the links of a few posts from X, each gets a draft, and for
 * each one Reply on X, post it there, I posted it; the item leaves and the
 * next one opens. On a wide screen the list is on the left and the open
 * item on the right, with J/K, R, P, F and S on the keyboard.
 *
 * The product drafts and checks; the person posts. Nothing on this screen
 * posts anywhere. No sentence explains a tab. Passing notices are toasts;
 * errors stay on the page, where the person tapped.
 */

type InboxResponse = ({ hasBusiness: true; providers: string[] } & InboxPayload) | { hasBusiness: false };

/** Which tab, and whether To do is narrowed to the pages a sampled AI answer cited (`?source=ai_visibility`). */
interface TodayFilter {
  tab: TodayViewId;
  aiCited: boolean;
}
type Payload = InboxResponse & { view: TodayFilter };

/** The list a filter shows: a tab's own, or the AI-cited open rows. */
function listOf(filter: TodayFilter): InboxViewId {
  return filter.aiCited ? "ai_cited" : todayViewList(filter.tab);
}

/** What `GET /api/today` answers that the page uses: the "Also today" cards. */
interface ScreenResponse {
  hasBusiness?: boolean;
  alsoToday?: AlsoTodayItem[];
}

const POLL_MS = 5_000;

/** What `POST /api/placements/add` answers. */
interface AddResponse {
  error?: string;
  code?: string;
  outcome?: AddOutcome;
  textFrom?: "x" | "pasted" | "stored";
  target?: PlacementTargetRecord;
  draft?: { started: boolean; error: string | null };
}

type CardNote = { tone: "info" | "error"; text: string; kind?: DraftFailureKind };
type ManualMove =
  | "dismiss"
  | "snooze"
  | "reopen"
  | "mark_published"
  | "unmark_published"
  | "set_published_url"
  | "mark_removed"
  | "unmark_removed";

/**
 * Whether GTF is looking for a reply's link on X at this moment: after I
 * posted it, judged on the tap's own clock, since the page may have sat open
 * long after it last loaded.
 */
function lookingNow(target: PlacementTargetRecord, finderOn: boolean): boolean {
  return linkFinding(target, { finderOn, now: Date.now() })?.state === "looking";
}

/** Ids in a set held as state, one toggled at a time. */
function toggled(current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * The tab from the address: `?view=posted|archive|todo`. Growth → AI answers
 * links with `?source=ai_visibility` (CITED_PLACES_HREF; an old
 * `/placements?source=…` redirects here with the query): To do, narrowed to
 * the pages a sampled AI answer cited.
 */
function initialFilters(): TodayFilter {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const view = params.get("view");
  const aiCited = params.get("source") === AI_CITED_FILTER;
  return { tab: !aiCited && isTodayViewId(view) ? view : "todo", aiCited };
}

/** "Fri, Nov 13", beside the heading. */
function dayHeading(now: number): string {
  return new Date(now).toLocaleDateString(UI_LOCALE, { weekday: "short", month: "short", day: "numeric" });
}

export default function TodayPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [filters, setFilters] = useState<TodayFilter>(initialFilters);
  // "Also today", read apart (GET /api/today): null until it arrives, and when it could not be read.
  const [alsoToday, setAlsoToday] = useState<AlsoTodayItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // True while a different list is being fetched: the old one stays visible, dimmed.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Items whose draft is being written right now.
  const [writingIds, setWritingIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, CardNote>>({});
  const [discovering, setDiscovering] = useState(false);
  // Adding posts: what is typed, the text for a post X will not hand over, and how it went.
  const [addValue, setAddValue] = useState("");
  const [addText, setAddText] = useState("");
  const [showAddText, setShowAddText] = useState(false);
  const [addProgress, setAddProgress] = useState<string | null>(null);
  const [addReport, setAddReport] = useState<AddReport | null>(null);
  // The open item. `undefined`: none chosen yet, the first one opens; null: closed by the person.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  // Items whose Reply was tapped: their primary button is I posted it.
  const [replied, setReplied] = useState<Set<string>>(new Set());
  const [linkResult, setLinkResult] = useState<LinkBoxResult | null>(null);
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({});
  // When the lists were last judged: "expired" and "snoozed" depend on the hour.
  const [now, setNow] = useState(() => Date.now());
  const { toast, show: showToast, dismiss: dismissToast } = useToast();
  const twoPanes = useMediaQuery(TWO_PANES);
  const followers = useRef<Set<string>>(new Set());
  const paused = useRef<Set<string>>(new Set());
  const loadedView = useRef<string | null>(null);
  // Only the newest request may write: a slower response for the list the
  // person just left must not land on top of the one they are looking at.
  const requestSeq = useRef(0);
  const itemActions = useRef<ItemActions>({});
  const listRef = useRef<HTMLDivElement>(null);
  // Rows asked for by id whatever the list: the reply opened from the Today sheet.
  const includeIds = useRef<string[]>([]);
  // The Today sheet, behind "N of G today".
  const [todayOpen, setTodayOpen] = useState(false);
  // The goal on screen while its write is pending or failed: a reload in between does not undo the tap.
  const goalOverride = useRef<{ goal: number | null } | null>(null);
  const viewKey = `${filters.tab}|${filters.aiCited}`;

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams();
    params.set("status", viewStatus(listOf(filters)));
    if (filters.aiCited) params.set("source", AI_CITED_FILTER);
    const zone = browserTimeZone();
    if (zone) params.set("tz", zone);
    if (includeIds.current.length) params.set("include", includeIds.current.join(","));
    try {
      const response = await fetch(`/api/placements?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as InboxResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not load replies");
      if (seq !== requestSeq.current) return;
      // A goal changed in the Today sheet and not written yet wins over the one this response read.
      const goal = goalOverride.current;
      setData({ ...payload, ...(goal && "today" in payload && payload.today ? { today: { ...payload.today, goal: goal.goal } } : {}), view: filters });
      setNow(Date.now());
      loadedView.current = viewKey;
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Could not load replies");
    } finally {
      if (seq === requestSeq.current) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  }, [filters, viewKey]);

  // Load on arrival and on a changed list: every setState in load runs after the fetch.
  useEffect(() => {
    load();
  }, [load]);

  /**
   * "Also today" (GET /api/today, what `get_today` answers): read on arrival
   * and again after what can resolve a card here (a link saved, a fact
   * confirmed). A failed read hides the section rather than showing it empty.
   */
  const loadAlsoToday = useCallback(async () => {
    try {
      const zone = browserTimeZone();
      const response = await fetch(`/api/today${zone ? `?tz=${encodeURIComponent(zone)}` : ""}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as ScreenResponse;
      setAlsoToday(response.ok && Array.isArray(payload.alsoToday) ? payload.alsoToday : null);
    } catch {
      setAlsoToday(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read on mount: its setState runs after the fetch
    void loadAlsoToday();
  }, [loadAlsoToday]);

  // A web run or the X search going: the list fills as it runs.
  const running = data?.hasBusiness ? data.discovery.running || Boolean(data.discovery.x?.running) : false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const setBusy = (id: string, on: boolean) => setBusyIds((current) => toggled(current, id, on));
  // Which move each item is waiting on, so the button that started it shows
  // a spinner. Per item: one item's request never freezes another's buttons.
  const [pending, setPending] = useState<Record<string, ManualMove>>({});
  // The reply just marked as posted, while the sheet offers its link.
  const [linkSheet, setLinkSheet] = useState<PlacementTargetRecord | null>(null);
  const sheetOpen = linkSheet !== null;

  /**
   * The link sheet closed. Saved or skipped, the reply stays posted; a
   * skipped one keeps the Undo it always had (back to To reply), a saved one
   * has none: the server refuses to unpost a reply whose link is on record.
   */
  const closeLinkSheet = (outcome: LinkSheetOutcome) => {
    const id = linkSheet?.id;
    setLinkSheet(null);
    if (!id) return;
    showToast(linkSheetToast(outcome), outcome === "skipped" ? () => undoPosted(id) : undefined);
  };

  // The Undo of I posted it. It returns its request, so the toast turns while it runs.
  const undoPosted = (id: string) =>
    act(id, "unmark_published").then((refusal) => {
      if (refusal) setError(refusal);
      else setOpenId(id);
    });

  /** Whether GTF is looking for this posted reply's link on X, from the payload's switch and the reply's own search. */
  const findingOf = (target: PlacementTargetRecord) =>
    linkFinding(target, { finderOn: Boolean(data?.hasBusiness && data.findsReplyLinks), now });

  const changeFilters = useCallback((next: TodayFilter) => {
    includeIds.current = [];
    setOpenId(undefined);
    setLinkResult(null);
    setRowProblems({});
    // The old list stays on screen, dimmed, until the new one arrives.
    setRefreshing(true);
    setFilters(next);
  }, []);

  /**
   * A row of the Today sheet was tapped: the Posted list, with that reply
   * open. The reply is asked for by id too, so it is on the list even past
   * the inbox's cap of 200 rows.
   */
  const openTodayReply = (id: string) => {
    setTodayOpen(false);
    changeFilters({ tab: "posted", aiCited: false });
    includeIds.current = [id];
    setOpenId(id);
  };

  /** The goal changed in the Today sheet: the header's count and dots follow before it is saved. */
  const showGoal = (goal: number | null) => {
    goalOverride.current = { goal };
    setData((current) => (current && current.hasBusiness && current.today ? { ...current, today: { ...current.today, goal } } : current));
  };

  /**
   * Writes the goal through the partial update, so the other voice settings
   * stay as stored. Null once saved, else the sentence the sheet shows.
   */
  const saveGoal = async (goal: number | null): Promise<string | null> => {
    try {
      const response = await fetch("/api/business/voice-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyReplyGoal: goal }),
      });
      if (response.ok) {
        // Saved, and no newer tap since: the server's value is the one to show again.
        if (goalOverride.current?.goal === goal) goalOverride.current = null;
        return null;
      }
      const payload = await response.json().catch(() => ({}));
      return `The goal was not saved: ${payload.error ?? "the request failed"}.`;
    } catch {
      return "The goal was not saved: no connection.";
    }
  };

  /** The rows of the list on screen, in the server's order. */
  const rows = useMemo(() => {
    if (!data || !data.hasBusiness) return [];
    // Judged against the list the rows were loaded for: while another list
    // loads, the old rows stay on screen and are not filtered by the new one.
    return data.targets.filter((target) => inView(target, listOf(data.view), now));
  }, [data, now]);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);

  // In To do the first post opens by itself; Posted and Archive stay
  // closed, a posted row carries Paste link. Two panes always show one.
  const opensByItself = data?.hasBusiness ? viewStatus(listOf(data.view)) === "open" : false;
  const open =
    openId && rowIds.includes(openId) ? openId : openId === null && !twoPanes ? null : opensByItself || twoPanes ? (rowIds[0] ?? null) : null;

  const post = async (url: string, body?: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Request failed");
    return payload;
  };

  const runDiscovery = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await post("/api/placements/discover");
      showToast({
        text: result.alreadyRunning
          ? "A discovery run is already in progress."
          : result.outcome === "completed"
            ? "Discovery finished."
            : "Discovery started. New finds appear here as it judges them.",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start discovery");
    } finally {
      setDiscovering(false);
    }
  };

  const replaceTarget = (target: PlacementTargetRecord) =>
    setData((current) =>
      current && current.hasBusiness
        ? { ...current, targets: current.targets.map((t) => (t.id === target.id ? { ...target, drafts: t.drafts } : t)) }
        : current
    );

  /**
   * One manual move. Null when it was recorded, otherwise the server's
   * sentence. An item that no longer belongs to the list leaves it at once
   * and the next one opens; a toast says what happened, with its Undo.
   */
  const act = async (
    id: string,
    action: ManualMove,
    extra: Record<string, unknown> = {},
    quiet = false
  ): Promise<string | null> => {
    setBusy(id, true);
    setPending((current) => ({ ...current, [id]: action }));
    setError(null);
    try {
      const result = await post(`/api/placements/${id}/action`, { action, ...extra });
      const target = result.target as PlacementTargetRecord;
      if (data?.hasBusiness && !inView(target, listOf(data.view), now) && open === id) setOpenId(nextOpenId(rowIds, id));
      replaceTarget(target);
      if (action === "mark_published") {
        setReplied((current) => toggled(current, id, false));
        dismissToast();
        // Recorded. GTF finds the link on X by itself where it can; elsewhere
        // the sheet offers it, and its toast comes when it closes.
        if (lookingNow(target, Boolean(data?.hasBusiness && data.findsReplyLinks))) showToast(findingToast(), () => undoPosted(id));
        else setLinkSheet(target);
      } else if (quiet) {
        // The sheet's own save: it says so when it closes.
      } else if (action === "dismiss") {
        showToast(leftToast(action), () => act(id, "reopen").then((refusal) => (refusal ? setError(refusal) : setOpenId(id))));
      } else if (action === "snooze" || action === "reopen" || action === "set_published_url") {
        showToast(leftToast(action));
      } else if (action === "mark_removed") {
        showToast({ text: "Marked as removed.", action: { label: "Undo" } }, () =>
          act(id, "unmark_removed").then((refusal) => {
            if (refusal) setError(refusal);
          })
        );
      }
      await load();
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed";
      // What the person tapped on the item answers there; the rest at the top.
      if (action === "dismiss" || action === "snooze" || action === "reopen") setError(message);
      return message;
    } finally {
      setBusy(id, false);
      setPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const requestDraft = async (
    id: string,
    continueOnly: boolean,
    anyway = false
  ): Promise<
    | { kind: "done"; status: string | null; writes: number | null; omitted: string[] }
    | { kind: "failed"; error: string; reason: DraftFailureKind }
    | { kind: "pending" }
  > => {
    try {
      const ask = continueOnly ? { continue: true } : anyway ? { anyway: true } : null;
      const response = await fetch(`/api/placements/${id}/draft`, {
        method: "POST",
        headers: ask ? { "Content-Type": "application/json" } : undefined,
        body: ask ? JSON.stringify(ask) : undefined,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        kind?: DraftFailureKind;
        outcome?: string;
        status?: string | null;
        writes?: number | null;
        omitted?: string[] | null;
      };
      if (!response.ok) {
        // A platform timeout has no JSON body. The job may still be going,
        // so this is "still writing", not a failure with nothing to say.
        if (response.status === 504) return { kind: "pending" };
        return { kind: "failed", error: payload.error ?? "Could not draft", reason: payload.kind ?? "failed" };
      }
      if (payload.outcome === "completed") {
        return { kind: "done", status: payload.status ?? null, writes: payload.writes ?? null, omitted: payload.omitted ?? [] };
      }
      if (payload.outcome === "idle") {
        return { kind: "failed", error: "The draft stopped before it was written. Draft it again.", reason: "failed" };
      }
      return { kind: "pending" };
    } catch {
      return { kind: "pending" };
    }
  };

  const followDraft = useCallback(
    // `anyway`: "Write it anyway" on a declined item. Only the click sends it.
    // Answers what the item says once it ends (a refusal is an error note),
    // so a swipe can say it on the row it came from.
    async (id: string, manual: boolean, anyway = false): Promise<CardNote | null> => {
      if (manual) paused.current.delete(id);
      if (followers.current.has(id) || (!manual && paused.current.has(id))) return null;
      followers.current.add(id);
      setBusyIds((current) => toggled(current, id, true));
      setWritingIds((current) => toggled(current, id, true));
      setError(null);
      let said: CardNote | null = null;
      const say = (note: CardNote | null) => {
        said = note;
        setNotes((current) => {
          const next = { ...current };
          if (note) next[id] = note;
          else delete next[id];
          return next;
        });
      };
      say({ tone: "info", text: draftWaitMessage() });
      const started = Date.now();
      // Only the click enqueues a draft. Every ask after that continues the
      // one already running, so a finished job is not started a second time.
      let continueOnly = !manual;
      try {
        while (Date.now() - started < DRAFT_WAIT_MS) {
          const result = await requestDraft(id, continueOnly, anyway);
          continueOnly = true;
          if (result.kind === "done") {
            // A variant that did not pass is missing from the item: said there, once.
            const finished = draftFinishedMessage(result.status, result.writes, result.omitted);
            say(result.omitted.length ? { tone: "info", text: finished } : null);
            await load();
            return said;
          }
          if (result.kind === "failed") {
            say({ tone: "error", text: result.error, kind: result.reason });
            return said;
          }
          say({ tone: "info", text: draftStillWaitingMessage() });
          await new Promise((resolve) => setTimeout(resolve, DRAFT_POLL_MS));
        }
        paused.current.add(id);
        say({ tone: "info", text: draftGaveUpWaitingMessage() });
        return said;
      } finally {
        followers.current.delete(id);
        setBusyIds((current) => toggled(current, id, false));
        setWritingIds((current) => toggled(current, id, false));
      }
    },
    [load]
  );

  const draftingKey = data?.hasBusiness ? (data.draftingTargetIds ?? []).join(",") : "";
  useEffect(() => {
    if (!draftingKey) return;
    for (const id of draftingKey.split(",")) void followDraft(id, false);
  }, [draftingKey, followDraft]);

  /**
   * Adds the posts one after the other, so each draft's cap and the spend
   * ceiling are asked for each (the add route does). A refusal that would
   * be the same for every post (signed out, no plan, a cap, the ceiling)
   * stops the run, and the links left are listed with that reason.
   */
  const addPosts = async (links: string[], over: number) => {
    if (addProgress !== null) return;
    setError(null);
    setAddReport(null);
    const attempts: AddAttempt[] = [];
    const held = new Set<string>();
    let stopped: string | null = null;
    let last: AddResponse | null = null;
    try {
      for (const [index, link] of links.entries()) {
        if (stopped) {
          attempts.push({ link, error: stopped });
          continue;
        }
        setAddProgress(links.length === 1 ? "Adding…" : `Adding ${index + 1} of ${links.length}…`);
        try {
          const response = await fetch("/api/placements/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: link, text: links.length === 1 && addText.trim() ? addText : null }),
          });
          const payload = (await response.json().catch(() => ({}))) as AddResponse;
          if (!response.ok || !payload.target) {
            const message = payload.error ?? "Could not add this post.";
            // X would not hand the post over and there was no text: open the field for it.
            if (links.length === 1 && payload.code === "text_needed") setShowAddText(true);
            attempts.push({ link, error: message });
            if ([401, 402, 429, 503].includes(response.status)) stopped = message;
            continue;
          }
          attempts.push({ link, error: null });
          last = payload;
          const target = payload.target;
          setData((current) =>
            current && current.hasBusiness
              ? { ...current, targets: [target, ...current.targets.filter((t) => t.id !== target.id)] }
              : current
          );
          if (payload.draft?.started) {
            // The job is already enqueued: follow it, the way "Draft it" is followed.
            void followDraft(target.id, false);
          } else if (payload.draft?.error) {
            const text = payload.draft.error;
            held.add(text);
            setNotes((current) => ({ ...current, [target.id]: { tone: "error", text } }));
          }
        } catch {
          attempts.push({ link, error: "Could not reach the server." });
        }
      }
    } finally {
      setAddProgress(null);
    }
    const summary = addSummary(attempts, over);
    const added = attempts.filter((a) => !a.error);
    if (summary.failed.length === 0) {
      setAddValue("");
      setAddText("");
      setShowAddText(false);
    } else {
      // What is left in the field is what was not added, to fix and try again.
      setAddValue(summary.failed.map((a) => a.link).join(" "));
    }
    if (summary.failed.length > 0 || summary.capped || held.size > 0) {
      setAddReport({ text: summary.text, failed: summary.failed, notes: [...(summary.capped ? [summary.capped] : []), ...held] });
    }
    if (added.length === 1 && links.length === 1 && last) {
      showToast(addedToast(last.outcome, last.textFrom, last.draft?.started === true));
    } else if (added.length > 0) {
      showToast({ text: summary.text });
    }
    if (added.length > 0) {
      // A post just added is one to reply to: show it where it is.
      if (filters.tab !== "todo" || filters.aiCited) changeFilters({ tab: "todo", aiCited: false });
      else {
        setOpenId(undefined);
        await load();
      }
    }
  };

  /**
   * Saves one draft and puts what the server stored (text, link, checks)
   * on that item only, with the target's status the save may have moved.
   * No reload of the inbox: the person is in the middle of replying.
   */
  const saveDraft = async (draftId: string, body: string, linkUrl: string | null): Promise<SaveDraftResult> => {
    try {
      const response = await fetch(`/api/placements/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, linkUrl }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        draft?: PlacementDraftRecord;
        targetStatus?: string;
      };
      if (!response.ok || !payload.draft) return { ok: false, error: payload.error ?? "Could not save the draft." };
      const saved = payload.draft;
      setData((current) =>
        current && current.hasBusiness ? { ...current, targets: withSavedDraft(current.targets, saved, payload.targetStatus) } : current
      );
      return { ok: true, draft: saved };
    } catch {
      return { ok: false, error: "Could not save the draft. Check your connection and try again." };
    }
  };

  /**
   * "Fix": the person's note and the text as it stands go to the correction
   * route, which keeps the note, rewrites the draft once and re-checks it.
   * The rewrite lands on that item only, the way a save does. A refusal is
   * the server's sentence, with the page that fixes its cause
   * (`settingsHref`, or `href` from the paywall) when there is one.
   */
  const correctDraft = async (draftId: string, reason: string, body: string | null): Promise<CorrectionResult> => {
    try {
      const response = await fetch(`/api/placements/drafts/${draftId}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, body }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        settingsHref?: string;
        href?: string;
        draft?: PlacementDraftRecord;
        targetStatus?: string;
        feedbackId?: string;
      };
      if (!response.ok || !payload.draft || !payload.feedbackId) {
        return {
          ok: false,
          // A platform timeout has no JSON body: say what is known.
          error: payload.error ?? "The rewrite did not come back. Reload to see the draft as it is now, or try again.",
          href: payload.settingsHref ?? payload.href ?? null,
        };
      }
      const saved = payload.draft;
      setData((current) =>
        current && current.hasBusiness ? { ...current, targets: withSavedDraft(current.targets, saved, payload.targetStatus) } : current
      );
      return { ok: true, draft: saved, feedbackId: payload.feedbackId };
    } catch {
      return { ok: false, error: "Could not reach the server, so the draft is unchanged. Check your connection and try again." };
    }
  };

  /** "Remember this note": the note behind a rewrite becomes a line of Settings → Voice. */
  const promoteNote = async (feedbackId: string): Promise<PromoteNoteResult> => {
    try {
      const response = await fetch(`/api/placements/feedback/${feedbackId}/promote`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; appended?: boolean };
      if (!response.ok) return { ok: false, error: payload.error ?? "Could not add it to your notes. Try again." };
      return { ok: true, appended: payload.appended === true };
    } catch {
      return { ok: false, error: "Could not reach the server. Check your connection and try again." };
    }
  };

  /**
   * "It's true: add to About you": one fact the person confirmed, appended
   * to About you (lib/voice/about-you.ts). The item then judges the same
   * text again through `saveDraft`, the "Check again" path.
   */
  const addFact = async (fact: string): Promise<AddFactResult> => {
    try {
      const response = await fetch("/api/business/voice-settings/about-you", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; aboutYou?: string; fact?: string; added?: boolean };
      if (!response.ok || typeof payload.aboutYou !== "string") return { ok: false, error: payload.error ?? "Could not add it to About you. Try again." };
      return { ok: true, aboutYou: payload.aboutYou, fact: payload.fact ?? fact, added: payload.added === true };
    } catch {
      return { ok: false, error: "Could not reach the server. Check your connection and try again." };
    }
  };

  /** Its Undo: the exact sentence out, refused when About you changed since. */
  const removeFact = async (fact: string, aboutYou: string): Promise<RemoveFactResult> => {
    try {
      const response = await fetch("/api/business/voice-settings/about-you", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact, ifAboutYouIs: aboutYou }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { ok: false, error: payload.error ?? "Could not undo it. Edit About you in Settings → Voice." };
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach the server. Check your connection and try again." };
    }
  };

  /**
   * "Still true" on a card of Also today: the day is recorded apart from
   * the sentence (`confirm_about_you_fact`, About you is not written), the
   * card leaves, and the toast's Undo puts that one confirmation back as it
   * was (`undo.previousConfirmedOn`, removed when there was none).
   */
  const confirmFact = async (sentence: string): Promise<string | null> => {
    try {
      const response = await fetch("/api/business/voice-settings/about-you", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; previousConfirmedOn?: string | null };
      if (!response.ok) return payload.error ?? "It was not saved. Try again.";
      setAlsoToday((current) => current?.filter((item) => !(item.kind === "fact_stale" && item.sentence === sentence)) ?? current);
      const previous = payload.previousConfirmedOn;
      showToast(
        { text: "Marked as still true.", action: previous !== undefined ? { label: "Undo" } : undefined },
        previous !== undefined ? () => undoConfirmFact(sentence, previous) : undefined
      );
      return null;
    } catch {
      return "Could not reach the server. Check your connection and try again.";
    }
  };

  const undoConfirmFact = async (sentence: string, previousConfirmedOn: string | null) => {
    try {
      const response = await fetch("/api/business/voice-settings/about-you", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence, undo: { previousConfirmedOn } }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(`It was not undone: ${payload.error ?? "the request failed"}. Edit About you in Settings → Voice.`);
      }
    } catch {
      setError("It was not undone: no connection. Edit About you in Settings → Voice.");
    } finally {
      await loadAlsoToday();
    }
  };

  /** Paste link on a card of Also today, or in the Today sheet: the one action a link is saved by. */
  const saveLink = async (id: string, publishedUrl: string): Promise<string | null> => {
    const refusal = await act(id, "set_published_url", { publishedUrl });
    if (!refusal) void loadAlsoToday();
    return refusal;
  };

  /**
   * "Write my own": stores the person's reply on an item that had no draft,
   * before the other site opens, and puts the new draft on that item only,
   * so "I posted it" records which text went out.
   */
  const saveOwnReply = async (targetId: string, body: string): Promise<SaveDraftResult> => {
    try {
      const response = await fetch(`/api/placements/${targetId}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        draft?: PlacementDraftRecord;
        targetStatus?: string;
      };
      if (!response.ok || !payload.draft) return { ok: false, error: payload.error ?? "Could not save your reply." };
      const saved = payload.draft;
      setData((current) =>
        current && current.hasBusiness
          ? {
              ...current,
              targets: current.targets.map((t) =>
                t.id === targetId
                  ? {
                      ...t,
                      status: (payload.targetStatus as PlacementTargetRecord["status"] | undefined) ?? t.status,
                      // A second save replaces the person's earlier own reply.
                      drafts: [...t.drafts.filter((d) => !isHumanWritten(d)), saved],
                    }
                  : t
              ),
            }
          : current
      );
      return { ok: true, draft: saved };
    } catch {
      return { ok: false, error: "Could not save your reply. Check your connection and try again." };
    }
  };

  /**
   * "Paste your reply links": asks which posted reply each link belongs to
   * (the match-links route decides, and never guesses), saves the ones that
   * are sure through the same action a single link is saved by, and keeps
   * the others as questions on the box.
   */
  const matchLinks = async (links: string[], over: number) => {
    setError(null);
    try {
      const response = await fetch("/api/placements/match-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; matches?: LinkMatch[] };
      if (!response.ok || !payload.matches) {
        setLinkResult({ saved: 0, picks: [], refused: [{ link: links[0], error: payload.error ?? "The links could not be matched. Try again." }] });
        return;
      }
      const result: LinkBoxResult = { saved: 0, picks: [], refused: [] };
      for (const match of payload.matches) {
        if (match.kind === "pick") result.picks.push(match);
        else if (match.kind === "refused") result.refused.push({ link: match.link, error: match.error });
        else {
          const refusal = await act(match.targetId, "set_published_url", { publishedUrl: match.link });
          if (refusal) result.refused.push({ link: match.link, error: refusal });
          else result.saved += 1;
        }
      }
      if (over > 0) result.refused.push({ link: `${over} more`, error: "left out: 10 links at a time." });
      setLinkResult(result);
    } catch {
      setLinkResult({ saved: 0, picks: [], refused: [{ link: links[0], error: "Could not reach the server." }] });
    }
  };

  const pickLink = async (link: string, targetId: string): Promise<string | null> => {
    const refusal = await act(targetId, "set_published_url", { publishedUrl: link });
    if (!refusal) {
      setLinkResult((current) => (current ? { ...current, saved: current.saved + 1, picks: current.picks.filter((p) => p.link !== link) } : current));
    }
    return refusal;
  };

  const setRowProblem = (id: string, problem: string | null) =>
    setRowProblems((current) => {
      const next = { ...current };
      if (problem) next[id] = problem;
      else delete next[id];
      return next;
    });

  /**
   * A swipe (or its button) on a row of "Found for you": the item's own
   * actions, no new request. Skip is the item's Skip and answers whether it
   * was recorded, so a refused skip brings the row back; Draft it is the
   * item's Draft it, under the same caps and ceiling, and a refusal is said
   * under the row it was swiped on.
   */
  const swipeAction = (target: PlacementTargetRecord, action: SwipeAction): Promise<boolean> | void => {
    setRowProblem(target.id, null);
    switch (action.kind) {
      case "skip":
        return act(target.id, "dismiss").then((refusal) => refusal === null);
      case "open":
        setOpenId(target.id);
        return;
      case "open_article":
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      case "draft":
        return followDraft(target.id, true).then((note) => {
          if (note?.tone === "error") setRowProblem(target.id, note.text);
          return note?.tone !== "error";
        });
    }
  };

  // J/K move through the list, R/P/F/S press the open item. Never while typing.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const shortcut = shortcutFor(event, { dialogOpen: sheetOpen || todayOpen });
      if (!shortcut) return;
      if (shortcut === "next" || shortcut === "previous") {
        const next = stepOpenId(rowIds, open, shortcut === "next" ? 1 : -1);
        if (next) setOpenId(next);
        event.preventDefault();
        return;
      }
      const press = itemActions.current[shortcut];
      if (press) {
        press();
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rowIds, open, sheetOpen, todayOpen]);

  // The open item is brought into view where it sits in the list. On a
  // phone the page does not scroll, the app's scrolling area does
  // (components/dashboard/app-scroll.tsx): scrollIntoView moves that one.
  // Not the item that opened by itself on arrival (`openId` undefined):
  // Today opens at its top, on the day's progress.
  const chosen = openId !== undefined;
  useEffect(() => {
    if (!open || !chosen) return;
    const el = listRef.current?.querySelector<HTMLElement>(twoPanes ? `[data-row="${open}"]` : `[data-open-item="${open}"]`);
    if (!el) return;
    // Left alone when it is already in view, with room under it for the tab
    // bar and a toast; otherwise centred, so its primary button is on screen.
    const box = el.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight - 140) return;
    el.scrollIntoView({ block: box.height > window.innerHeight - 200 ? "start" : "center" });
  }, [open, chosen, twoPanes]);

  if (isLoading) {
    return (
      <RepliesLoading />
    );
  }

  if (!data || !data.hasBusiness) {
    return (
      <div className="max-w-lg space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Today</h1>
        {error && <Problem>{error}</Problem>}
        <p className="text-sm text-muted-foreground">
          Set up your business first.{" "}
          <Link href="/settings/business" className="underline underline-offset-2">
            Settings → Business
          </Link>
        </p>
      </div>
    );
  }

  const sources = describeDiscoverySources(data.providers);
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const list = listOf(data.view);
  const tab = data.view.tab;
  const grouped = viewStatus(list) === "open";
  const posted = tab === "posted" && !data.view.aiCited;
  const archived = tab === "archive" && !data.view.aiCited;
  const openTarget = open ? (rows.find((row) => row.id === open) ?? null) : null;
  const draftable = ["qualified", "drafted", "needs_review", "approved"];
  const noteFor = (target: PlacementTargetRecord): CardNote | null => {
    if (notes[target.id]) return notes[target.id];
    // How the last draft ended, from the server, so a reload keeps it.
    const failure = data.lastDraftFailures?.[target.id];
    return failure && draftable.includes(target.status) && target.drafts.length === 0 ? { tone: "error", ...failure } : null;
  };
  const failureOf = (target: PlacementTargetRecord): DraftFailureKind | null => {
    const note = noteFor(target);
    return note?.tone === "error" ? (note.kind ?? "failed") : null;
  };
  const webRunning = data.discovery.running;
  const discoveryBusy = webRunning || discovering;
  // "Judging 23 of 60…" from the job's own checkpoints, under the tabs.
  const progressText = webRunning ? (data.discovery.progress ?? "Discovering…") : discovering ? "Starting…" : null;
  const searchNote = lastSearchText(data.discovery, now);
  const nextSearch = sources.canRun ? nextSearchLabel(data.discovery, browserTimeZone()) : null;
  const links = todayLinks(data.today?.replies, { finderOn: Boolean(data.findsReplyLinks), now });

  // At the right of the open item's header: Close where it sits in the
  // list, Open post in the pane beside it.
  const item = (target: PlacementTargetRecord, headerEnd: ReactNode) =>
    target.status === "published_manually" ? (
      <PostedItem
        key={target.id}
        target={target}
        now={now}
        business={data.business}
        headerEnd={headerEnd}
        aeoQueries={data.aeoQueries}
        busy={busyIds.has(target.id)}
        finding={findingOf(target)}
        onSetPublishedUrl={(publishedUrl) => saveLink(target.id, publishedUrl)}
        onMarkRemoved={(reason) => act(target.id, "mark_removed", reason ? { reason } : {})}
        onUnmarkRemoved={() => act(target.id, "unmark_removed")}
      />
    ) : (
      <ReplyItem
        key={target.id}
        target={target}
        now={now}
        business={data.business}
        headerEnd={headerEnd}
        busy={busyIds.has(target.id)}
        pending={pending[target.id] ?? null}
        writing={writingIds.has(target.id)}
        note={noteFor(target)}
        writerUseRecorded={inboxWriterUseRecorded(data)}
        replied={replied.has(target.id)}
        onRepliedChange={(on) => setReplied((current) => toggled(current, target.id, on))}
        onDraft={() => void followDraft(target.id, true)}
        onDraftAnyway={() => void followDraft(target.id, true, true)}
        onAction={(action) => void act(target.id, action)}
        onMarkPublished={(extra) => act(target.id, "mark_published", extra)}
        onSaveDraft={saveDraft}
        onSaveOwnReply={(body) => saveOwnReply(target.id, body)}
        onCorrectDraft={correctDraft}
        onPromoteNote={promoteNote}
        onAddFact={addFact}
        onRemoveFact={removeFact}
        onActions={(actions) => {
          itemActions.current = actions;
        }}
      />
    );

  // The closed rows of To do that were found for the person swipe; the first of them on a phone shows how, once.
  const row = (target: PlacementTargetRecord, group: InboxGroup | null = null, hint = false) =>
    !twoPanes && target.id === open ? (
      <OpenInPlace key={target.id} target={target}>
        {item(target, <CloseItem onClose={() => setOpenId(null)} />)}
      </OpenInPlace>
    ) : (
      <div key={target.id} className="border-b border-foreground/10 last:border-b-0" data-row-wrap="">
        <QueueRow
          target={target}
          now={now}
          writing={writingIds.has(target.id)}
          failure={failureOf(target)}
          selected={twoPanes && target.id === open}
          onOpen={() => setOpenId(target.id)}
          linkLooking={findingOf(target)?.state === "looking"}
          busy={busyIds.has(target.id)}
          // In the Archive the row says why it is there: Skipped, Filtered out, Expired, Removed.
          reason={archived ? archiveReason(target, now) : null}
          swipe={
            group && rowSwipes({ grouped, group, open: target.id === open })
              ? {
                  actions: rowSwipeActions(target, { writing: writingIds.has(target.id), failure: failureOf(target) }),
                  onAction: (action) => swipeAction(target, action),
                  hint,
                }
              : undefined
          }
          trailing={
            // A posted reply with no link carries Paste link on its row; one GTF is still looking for says so instead ("Finding link").
            posted && missingPublishedLink(target) && findingOf(target)?.state !== "looking" ? (
              <PasteLinkButton
                target={target}
                busy={busyIds.has(target.id)}
                onSave={(publishedUrl) => saveLink(target.id, publishedUrl)}
                onProblem={(problem) => setRowProblem(target.id, problem)}
              />
            ) : undefined
          }
        />
        {rowProblems[target.id] && (
          <div className="px-4 pb-2 lg:px-3">
            <Problem>{rowProblems[target.id]}</Problem>
          </div>
        )}
      </div>
    );

  // To do keeps its order: the posts the person chose, then what was found (`orderInbox`, `groupOf`).
  const ordered: PlacementTargetRecord[] = grouped
    ? (["yours", "found"] as const).flatMap((group) => rows.filter((r) => groupOf(r) === group))
    : rows;
  // On a phone the open reply is on top and the rest follows as "Next replies".
  const nextRows = grouped && !twoPanes ? ordered.filter((r) => r.id !== open) : ordered;
  // The row that nudges once on a phone: the first closed one found for the person.
  const hintId = twoPanes ? null : (nextRows.find((r) => groupOf(r) === "found")?.id ?? null);
  const missing = posted ? rows.filter((t) => missingPublishedLink(t)) : [];

  const empty =
    total === 0
      ? sources.canRun
        ? "Nothing here yet. Paste the link of a post on X above; you post the reply, never the product."
        : "Nothing here yet. Paste the link of a post on X above. Discovery is not searching yet: it is turned on once for the whole product."
      : data.view.aiCited
        ? "No open page a sampled AI answer cited."
        : tab === "todo"
          ? data.today && data.today.posted > 0
            ? "Done for today: nothing left to reply to."
            : "Nothing left to reply to."
          : tab === "posted"
            ? "No posted reply yet."
            : "Nothing in the archive.";

  const also = tab === "todo" && !data.view.aiCited && alsoToday ? (
    <AlsoToday items={alsoToday} now={now} busyIds={busyIds} onConfirmFact={confirmFact} onSaveLink={saveLink} />
  ) : null;

  const listBox = (children: ReactNode) => (
    <div className="overflow-hidden rounded-xl border border-border">{children}</div>
  );

  const rowList =
    nextRows.length === 0
      ? null
      : listBox(
          <>
            {posted && missing.length > 0 && (
              <LinkBox
                busy={refreshing}
                result={linkResult}
                candidates={missing}
                looking={missing.filter((t) => findingOf(t)?.state === "looking").length}
                now={now}
                onLinks={matchLinks}
                onPick={pickLink}
                onDismissPick={(link) =>
                  setLinkResult((current) => (current ? { ...current, picks: current.picks.filter((p) => p.link !== link) } : current))
                }
              />
            )}
            {nextRows.map((target) => (grouped ? row(target, groupOf(target), target.id === hintId) : row(target)))}
          </>
        );

  return (
    <div className="space-y-4">
      <div className="space-y-4 lg:max-w-2xl">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Today</h1>
          <span className="text-[13px] text-muted-foreground">{dayHeading(now)}</span>
        </div>

        {data.today && (
          <ProgressCard
            today={data.today}
            links={links}
            utcFallback={dayCountFallback(data.today, browserTimeZone())}
            open={todayOpen}
            onOpen={() => setTodayOpen(true)}
          />
        )}

        <div className="flex items-center gap-2">
          <ViewTabs
            value={filters.tab}
            todoCount={data.viewCounts?.to_reply ?? null}
            busy={refreshing}
            onChange={(next) => changeFilters({ tab: next, aiCited: false })}
          />
          <MoreMenu
            label="More actions"
            items={[
              {
                label: discoveryBusy ? "Discovering…" : sources.canRun ? "Run discovery" : "Discovery is not turned on yet",
                onSelect: () => void runDiscovery(),
                disabled: discoveryBusy || !sources.canRun,
                pending: discovering,
              },
              // When the scheduled searches run next, in the person's time zone.
              ...(nextSearch ? [{ label: nextSearch, onSelect: () => {}, disabled: true }] : []),
              // The daily X search, stopped by this month's cap: said where discovery is run.
              ...(data.xSearch?.line ? [{ label: data.xSearch.line, onSelect: () => {}, disabled: true }] : []),
            ]}
          />
        </div>

        {(progressText || refreshing || data.view.aiCited) && (
          <div className="flex flex-wrap items-center gap-2">
            {data.view.aiCited && (
              <button
                type="button"
                onClick={() => changeFilters({ tab: "todo", aiCited: false })}
                aria-label="Show every reply to do"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm md:min-h-8 md:text-xs"
              >
                Cited by AI (sampled)
                {data.viewCounts && <span className="tabular-nums text-muted-foreground">{data.viewCounts.ai_cited}</span>}
                <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </button>
            )}
            {progressText && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" role="status">
                <Search className="h-3 w-3" aria-hidden="true" /> {progressText}
              </span>
            )}
            {refreshing && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>
        )}

        {tab === "todo" && (
          <AddPostForm
            value={addValue}
            onChange={setAddValue}
            text={addText}
            onTextChange={setAddText}
            askForText={showAddText}
            progress={addProgress}
            report={addReport}
            onAdd={(links, over) => void addPosts(links, over)}
          />
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Two panes: Also today above them, the list beside the open item. */}
      {twoPanes && also}

      <div
        ref={listRef}
        aria-busy={refreshing}
        className={cn(
          twoPanes ? "grid grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start gap-6" : "space-y-4",
          refreshing && "pointer-events-none opacity-40 transition-opacity duration-200"
        )}
      >
        {twoPanes ? (
          <div className="space-y-2">
            {grouped && rows.length > 0 && <GroupHeading label="Replies" count={rows.length} note={searchNote} flush />}
            {rowList ?? <p className="py-6 text-sm text-muted-foreground">{empty}</p>}
          </div>
        ) : grouped ? (
          <>
            {openTarget ? (
              <OpenInPlace target={openTarget} card>
                {item(openTarget, <CloseItem onClose={() => setOpenId(null)} />)}
              </OpenInPlace>
            ) : rows.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{empty}</p>
            ) : null}
            {also}
            {nextRows.length > 0 && (
              <section aria-label="Next replies" className="space-y-2">
                <GroupHeading label="Next replies" count={nextRows.length} note={searchNote} flush />
                {rowList}
              </section>
            )}
          </>
        ) : (
          (rowList ?? <p className="py-2 text-sm text-muted-foreground">{empty}</p>)
        )}

        {twoPanes && (
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-xl border border-border bg-background p-6">
            {openTarget ? (
              <div className="max-w-2xl space-y-3">
                {item(
                  openTarget,
                  <a href={openTarget.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Open post
                  </a>
                )}
                <p className="pt-2 text-xs text-muted-foreground">
                  <Key>J</Key> <Key>K</Key> next, previous
                  {openTarget.status !== "published_manually" && (
                    <>
                      {" "}
                      · <Key>R</Key> reply · <Key>P</Key> I posted it · <Key>F</Key> fix · <Key>S</Key> skip
                    </>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{empty}</p>
            )}
          </div>
        )}
      </div>

      {linkSheet && (
        <LinkSheet
          key={linkSheet.id}
          target={linkSheet}
          onSave={(publishedUrl) => act(linkSheet.id, "set_published_url", { publishedUrl }, true)}
          onClose={closeLinkSheet}
        />
      )}
      {todayOpen && data.today && (
        <TodaySheet
          today={data.today}
          utcFallback={dayCountFallback(data.today, browserTimeZone())}
          now={now}
          busyIds={busyIds}
          onClose={() => setTodayOpen(false)}
          onOpenReply={openTodayReply}
          onSaveLink={saveLink}
          onGoalChange={showGoal}
          saveGoal={saveGoal}
        />
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function Key({ children }: { children: string }) {
  return <kbd className="rounded border border-foreground/20 bg-muted/40 px-1 font-mono text-xs">{children}</kbd>;
}

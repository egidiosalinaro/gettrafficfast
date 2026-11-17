import type { AuditCheck } from "@/lib/placements/audit";
import { FeedbackReason } from "@/lib/placements/feedback";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";
import { isExpired, isMine, isSnoozed } from "@/lib/placements/inbox-view";
import { isRemoved } from "@/lib/placements/removed";
import { surfaceLabel } from "@/lib/placements/surfaces";
import type { DraftFailureKind } from "@/lib/placements/draft-progress";
import { preferredDraft, takesReply } from "@/lib/placements/workflow";
import { UI_LOCALE } from "@/lib/format";
import { authorAvatar, authorHandle } from "@/lib/placements/avatar";

/**
 * What an item of the Replies queue says and does, without any markup: the
 * state word on its row, the age of the post, the audit in one mark, Reply
 * in one tap, Fix it, and the keyboard shortcuts. Kept apart from the
 * components (queue-row, reply-item, posted-item) so each rule is tested
 * without rendering anything.
 */

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(UI_LOCALE, { month: "short", day: "numeric" }) : "";
}

/** A calendar day, with the year: when a reply was posted, until when a post is snoozed. */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(UI_LOCALE, { year: "numeric", month: "short", day: "numeric" }) : "date unknown";
}

/**
 * How old a post is, in a word: "40m", "3h", "2d", then the day. On X a
 * reply matters in the first hours, and until 2026-11-10 a post from an
 * hour ago read "Nov 10, 2026" like one from the morning before. A search
 * engine's "4 months ago" was stored as the latest instant it allows, so
 * the honest word is a floor on the age: "4 months+". A day with no hour is
 * "today" or the count of days. Empty when the date is unknown: the row
 * says nothing rather than "date unknown".
 */
export function ageLabel(iso: string | null, precision: PlacementTargetRecord["postedAtPrecision"], now: number): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const days = Math.floor(minutes / 1440);
  if (precision === "week" || precision === "month" || precision === "year") {
    const unit =
      precision === "year"
        ? { n: Math.floor(days / 365), one: "year", many: "years" }
        : precision === "month"
          ? { n: Math.floor(days / 30), one: "month", many: "months" }
          : { n: Math.floor(days / 7), one: "week", many: "weeks" };
    const n = Math.max(1, unit.n);
    return `${n} ${n === 1 ? unit.one : unit.many}+`;
  }
  if (precision === "day") return days < 1 ? "today" : days < 7 ? `${days}d` : when(iso);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return days < 7 ? `${days}d` : when(iso);
}

/**
 * How old a post is, in words, for the open item (2026-11-12): "posted 3h
 * ago", "posted today", "posted at least 2 months ago" (a search engine's
 * "2 months ago" is a floor), "posted Oct 3"; "date unknown" when the source
 * gave no date, instead of nothing.
 */
export function postedPhrase(iso: string | null, precision: PlacementTargetRecord["postedAtPrecision"], now: number): string {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(at)) return "date unknown";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const days = Math.floor(minutes / 1440);
  if (precision === "week" || precision === "month" || precision === "year") {
    return `posted at least ${ageLabel(iso, precision, now).replace(/\+$/, "")} ago`;
  }
  if (precision === "day") return days < 1 ? "posted today" : days < 7 ? `posted ${days}d ago` : `posted ${when(iso)}`;
  if (minutes < 60) return `posted ${Math.max(1, minutes)}m ago`;
  if (minutes < 1440) return `posted ${Math.floor(minutes / 60)}h ago`;
  return days < 7 ? `posted ${days}d ago` : `posted ${when(iso)}`;
}

/**
 * When the product found a row, in a word, for the list: "found 3h ago",
 * "found 2d ago", then the day ("found Nov 3"). Empty when it cannot be read.
 */
export function foundLabel(iso: string | null | undefined, now: number): string {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `found ${Math.max(1, minutes)}m ago`;
  if (minutes < 1440) return `found ${Math.floor(minutes / 60)}h ago`;
  const days = Math.floor(minutes / 1440);
  return days < 7 ? `found ${days}d ago` : `found ${when(iso ?? null)}`;
}

/** When the product found a row, as a day, for the open item: "found Nov 10". Empty when it cannot be read. */
export function foundDay(iso: string | null | undefined): string {
  const day = when(iso ?? null);
  return day ? `found ${day}` : "";
}

/**
 * Whether a row says when it was found: a row found for the person. A post
 * the person added carries their own moment, and a posted reply its own.
 */
function showsFound(target: Pick<PlacementTargetRecord, "foundVia" | "qualifiedBy" | "status">): boolean {
  return target.status !== "published_manually" && !isMine(target);
}

/**
 * Whether a check is a note for the reviewer rather than a verdict: by the
 * `advisory` flag the gate writes on each check, or, for an audit stored
 * before the flag, by its id (`business_coherence`, the one advisory check).
 * Read defensively: the field is optional and absent on older rows.
 */
export function isAdvisoryCheck(check: Pick<AuditCheck, "id">): boolean {
  const flag = (check as { advisory?: unknown }).advisory;
  return typeof flag === "boolean" ? flag : check.id === "business_coherence";
}

/**
 * What the audit panel shows. Everything that counts passed: one line, "All
 * checks passed", the list behind "Show all checks". Otherwise only the
 * warnings and failures that count. An advisory check that did not pass is a
 * note (`notes`), never a warning: it does not stop "All checks passed", and
 * an amber triangle on it read as a failure on the owner's phone. A
 * "warning" verdict counts as passed only when an advisory note explains it
 * (a draft stored before advisory checks left the verdict); "blocked" never.
 */
export function auditSummary(audit: { status: string; checks: readonly AuditCheck[] }): {
  allPassed: boolean;
  flagged: AuditCheck[];
  notes: AuditCheck[];
} {
  const flagged = audit.checks.filter((check) => check.status !== "pass" && !isAdvisoryCheck(check));
  const notes = audit.checks.filter((check) => check.status !== "pass" && isAdvisoryCheck(check));
  const verdictPassed = audit.status === "passed" || (audit.status === "warning" && notes.length > 0);
  return { allPassed: verdictPassed && flagged.length === 0, flagged, notes };
}

/**
 * "@handle · date", said once. A post on X stores the handle twice (the
 * community is "@name", the author "name"), and the card printed
 * "@name · by name". The author is shown only when it is someone else
 * than the community: a subreddit and its poster, say.
 */
export function bylineParts(community: string | null, author: string | null): string[] {
  const plain = (value: string) => value.trim().replace(/^(@|u\/)/i, "").toLowerCase();
  const parts: string[] = [];
  if (community) parts.push(community);
  if (author && !(community && plain(community) === plain(author))) parts.push(`by ${author}`);
  return parts;
}

/**
 * One click, two things: the answer on the clipboard, then `url` in a new
 * tab, then whatever comes next on the card. Copy first: the clipboard needs
 * this document focused, and the click's activation still covers the open.
 * The open happens whether or not the copy worked: the text is on the card.
 */
export async function copyThenOpen(
  url: string,
  io: { copy: () => Promise<unknown>; open: (url: string) => void; then?: () => void }
): Promise<void> {
  await io.copy();
  io.open(url);
  io.then?.();
}

export type ReplyOutcome = "opened" | "blocked" | "save_failed";

/**
 * Reply on X (or Copy & open) in one tap, whatever state the draft is in.
 *
 * Edited and unsaved: saved and re-checked first, then opened with the text
 * as saved, so what goes out is what was checked. A draft the check blocks
 * is not opened by the plain button: the card shows the failing checks and
 * "Reply anyway", which passes `anyway` and opens it as it stands. A save
 * that fails opens nothing; its sentence is on the card.
 */
export async function replyThenOpen(io: {
  dirty: boolean;
  blocked: boolean;
  anyway: boolean;
  body: string;
  save: () => Promise<{ body: string; auditStatus: string } | null>;
  urlFor: (body: string) => string;
  copy: (body: string) => Promise<unknown>;
  open: (url: string) => void;
  then?: () => void;
}): Promise<ReplyOutcome> {
  let body = io.body;
  let blocked = io.blocked;
  if (io.dirty) {
    const saved = await io.save();
    if (!saved) return "save_failed";
    body = saved.body;
    blocked = saved.auditStatus === "blocked";
  }
  if (blocked && !io.anyway) return "blocked";
  await copyThenOpen(io.urlFor(body), { copy: () => io.copy(body), open: io.open, then: io.then });
  return "opened";
}

/** The primary button of a draft: where the reply goes. X opens its own composer; anywhere else the text is copied and the post opened. */
export function replyLabel(surface: string): string {
  return surface === "web" ? "Copy & open" : `Reply on ${surfaceLabel(surface)}`;
}

/** What saving a draft answers: the draft as stored and re-checked, or the server's sentence. */
export type SaveDraftResult = { ok: true; draft: PlacementDraftRecord } | { ok: false; error: string };

/**
 * The inbox's posts with one draft replaced by what the server stored, and
 * its post's status moved the way the server moved it. Nothing else changes:
 * a save, a re-check and a correction each update one card, never reload
 * the inbox, because the person is in the middle of replying.
 */
export function withSavedDraft(
  targets: PlacementTargetRecord[],
  saved: PlacementDraftRecord,
  targetStatus?: string | null
): PlacementTargetRecord[] {
  return targets.map((t) =>
    t.drafts.some((d) => d.id === saved.id)
      ? {
          ...t,
          status: (targetStatus as PlacementTargetRecord["status"] | null | undefined) ?? t.status,
          drafts: t.drafts.map((d) => (d.id === saved.id ? saved : d)),
        }
      : t
  );
}

/* ── Fix it: correct a draft with a note ─────────────────────────────── */

/** The notes the owner gives most, one tap each instead of typing on a phone. */
export const FIX_PRESETS = ["Sounds like AI", "Too long", "Use one of my numbers"] as const;

export const FIX_PLACEHOLDER = "What's wrong?";

/**
 * What a correction answers: the draft as rewritten, placed and re-checked,
 * with the id of the note that was kept; or the server's sentence, with where
 * to fix its cause when there is one (Settings → Voice for an empty About
 * you, the plans page without a subscription).
 */
export type CorrectionResult =
  | { ok: true; draft: PlacementDraftRecord; feedbackId: string }
  | { ok: false; error: string; href?: string | null };

/** What "Add to my notes" answers: whether the line was added (false: it was already there), or the server's sentence. */
export type PromoteNoteResult = { ok: true; appended: boolean } | { ok: false; error: string };

/** The Fix it box on one draft. One note at a time; the last rewrite's note can be kept for good. */
export interface FixItState {
  open: boolean;
  reason: string;
  rewriting: boolean;
  /** The sentence the last try ended on, and where to fix its cause. */
  error: { text: string; href: string | null } | null;
  /** The note behind the rewrite on the card, offered for the writer's notes; `blocked` when the rewrite still fails a check. */
  kept: { feedbackId: string; blocked: boolean } | null;
  promoting: boolean;
  /** What adding the note to the writer's notes answered. */
  promoted: { ok: boolean; text: string } | null;
}

export const FIX_IT_START: FixItState = {
  open: false,
  reason: "",
  rewriting: false,
  error: null,
  kept: null,
  promoting: false,
  promoted: null,
};

export type FixItEvent =
  | { type: "toggle" }
  | { type: "type"; reason: string }
  | { type: "preset"; preset: string }
  | { type: "submit" }
  | { type: "rewritten"; feedbackId: string; blocked: boolean }
  | { type: "refused"; error: string; href?: string | null }
  | { type: "promote" }
  | { type: "promoted"; ok: boolean; text: string };

/**
 * The note with a preset tapped: the preset alone in an empty box, added as
 * a sentence after what is there, and nothing when the note already says it.
 * Two taps ("Sounds like AI", "Too long") make one note.
 */
export function withPreset(reason: string, preset: string): string {
  const current = reason.trim();
  if (!current) return preset;
  if (current.toLowerCase().includes(preset.toLowerCase())) return reason;
  return `${current}${/[.!?]$/.test(current) ? "" : "."} ${preset}`;
}

/** The note's problem as the person reads it under the box, before any round trip; null when it can be sent. */
export function noteProblem(reason: string): string | null {
  const parsed = FeedbackReason.safeParse(reason);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Say what is wrong with the draft.");
}

export function fixIt(state: FixItState, event: FixItEvent): FixItState {
  switch (event.type) {
    case "toggle":
      if (state.rewriting) return state;
      return { ...state, open: !state.open, error: null };
    case "type":
      return { ...state, reason: event.reason, error: null };
    case "preset":
      return state.rewriting ? state : { ...state, reason: withPreset(state.reason, event.preset), error: null };
    case "submit":
      return state.rewriting ? state : { ...state, rewriting: true, error: null, kept: null, promoting: false, promoted: null };
    case "rewritten":
      return {
        ...state,
        open: false,
        reason: "",
        rewriting: false,
        error: null,
        kept: { feedbackId: event.feedbackId, blocked: event.blocked },
        promoting: false,
        promoted: null,
      };
    case "refused":
      return { ...state, open: true, rewriting: false, error: { text: event.error, href: event.href ?? null } };
    case "promote":
      return state.promoting || !state.kept ? state : { ...state, promoting: true, promoted: null };
    case "promoted":
      return { ...state, promoting: false, promoted: { ok: event.ok, text: event.text } };
  }
}

/**
 * Submit, in one place: the note checked as the server checks it, the
 * current text (edited or not) sent with it, and the rewrite put on the card
 * (`apply`) before the box says it is done. A refusal is the server's
 * sentence, shown under the box; nothing on the card changes.
 */
export async function correctThenApply(io: {
  reason: string;
  /** The text in the box now, edited or not. Empty: the stored draft is rewritten. */
  body: string;
  correct: (reason: string, body: string | null) => Promise<CorrectionResult>;
  apply: (draft: PlacementDraftRecord) => void;
}): Promise<Extract<FixItEvent, { type: "rewritten" | "refused" }>> {
  const problem = noteProblem(io.reason);
  if (problem) return { type: "refused", error: problem, href: null };
  const result = await io.correct(io.reason.trim(), io.body.trim() ? io.body : null);
  if (!result.ok) return { type: "refused", error: result.error, href: result.href ?? null };
  io.apply(result.draft);
  return { type: "rewritten", feedbackId: result.feedbackId, blocked: result.draft.auditStatus === "blocked" };
}

/** What the card says once "Add to my notes" answered. */
export function promotedSentence(appended: boolean): string {
  return appended
    ? "Added to your notes in Settings → Voice. Every draft follows it from now on."
    : "That is already in your notes: every draft follows it.";
}

export async function promoteNote(io: {
  feedbackId: string;
  promote: (feedbackId: string) => Promise<PromoteNoteResult>;
}): Promise<Extract<FixItEvent, { type: "promoted" }>> {
  const result = await io.promote(io.feedbackId);
  return result.ok
    ? { type: "promoted", ok: true, text: promotedSentence(result.appended) }
    : { type: "promoted", ok: false, text: result.error };
}

/** A link the server named for fixing a refusal: only a path on this site. */
export function ownPath(href: string | null): string | null {
  return href && href.startsWith("/") && !href.startsWith("//") ? href : null;
}

export function fixLinkLabel(href: string): string {
  if (href.startsWith("/settings/voice")) return "Open Settings → Voice";
  if (href.startsWith("/pricing")) return "See plans";
  if (href.startsWith("/settings/billing")) return "See what your plan includes";
  return "Open";
}

/** A tab opened during the tap, so a save in between does not get the open blocked. */
export function reserveTab(): Window | null {
  try {
    return window.open("", "_blank");
  } catch {
    return null;
  }
}

export function openIn(reserved: Window | null, url: string) {
  if (reserved && !reserved.closed) {
    reserved.opener = null;
    reserved.location.href = url;
    closeOnReturn(reserved);
    return;
  }
  if (isHomeScreenApp()) {
    // Opened without noopener here, so the page keeps a handle to close it.
    const opened = window.open(url, "_blank");
    if (opened) {
      opened.opener = null;
      closeOnReturn(opened);
    }
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * True when the app runs from the home screen (iOS `navigator.standalone`,
 * or the `standalone` display mode elsewhere). There a new tab is an in-app
 * browser sheet laid over the app, not a tab.
 */
export function isHomeScreenApp(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/**
 * In the home-screen app, Reply on X opens an in-app browser sheet, the X
 * app takes the link over, and the sheet stays behind, blank ("Search or
 * enter website name"), over the app when the person comes back
 * (2026-11-12). The sheet is closed the first time the app is seen again.
 * Only in the home-screen app: in a browser the X tab is the person's to
 * keep.
 */
export function closeOnReturn(opened: Window): void {
  if (!isHomeScreenApp()) return;
  const done = () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    done();
    try {
      if (!opened.closed) opened.close();
    } catch {
      // Not ours to close any more: nothing to do.
    }
  };
  // Seen again only after the person left: the listeners go on after the
  // tap, so the open itself does not count as a return.
  setTimeout(() => {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
  }, 500);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access refused: the text is right there to select.
    return false;
  }
}

/* ── The row ─────────────────────────────────────────────────────────── */

export type RowTone = "ready" | "warn" | "idle";

/**
 * The one word a row says about its item, and the colour of its dot. This
 * replaces the status pill, the "link missing" label and the badges a card
 * carried: Draft ready, Check failed, Writing…, Draft it, Ask to be listed,
 * No link, Finding link (GTF is looking for it on X, `linkLooking`), Linked,
 * Removed, Skipped, Filtered out, Not sorted yet.
 */
export function rowState(
  target: Pick<PlacementTargetRecord, "status" | "kind" | "drafts" | "publishedUrl" | "removedAt">,
  options: { writing?: boolean; failure?: DraftFailureKind | null; linkLooking?: boolean } = {}
): { word: string; tone: RowTone } {
  if (options.writing) return { word: "Writing…", tone: "idle" };
  switch (target.status) {
    case "published_manually":
      if (isRemoved(target)) return { word: "Removed", tone: "idle" };
      if (target.publishedUrl) return { word: "Linked", tone: "ready" };
      return options.linkLooking ? { word: "Finding link", tone: "idle" } : { word: "No link", tone: "warn" };
    case "rejected":
      return { word: "Filtered out", tone: "idle" };
    case "dismissed":
      return { word: "Skipped", tone: "idle" };
    case "discovered":
      return { word: "Not sorted yet", tone: "idle" };
  }
  if (!takesReply(target.kind)) return { word: "Ask to be listed", tone: "idle" };
  const draft = preferredDraft(target.drafts);
  if (draft) {
    return draft.auditStatus === "blocked" ? { word: "Check failed", tone: "warn" } : { word: "Draft ready", tone: "ready" };
  }
  if (options.failure === "declined") return { word: "Not drafted", tone: "warn" };
  if (options.failure) return { word: "Draft failed", tone: "warn" };
  return { word: "Draft it", tone: "idle" };
}

/**
 * The row's first line: platform, who, how old, and for a found thread how
 * busy it is. No pill, no badge: plain words separated by dots. Since
 * 2026-11-12 a found row says two times: how old the post is ("3h", or
 * "date unknown" when the source gave none) and when it was found ("found
 * 2d ago", from `foundAt`, the first sighting).
 */
export function rowMeta(
  target: Pick<
    PlacementTargetRecord,
    "surface" | "community" | "author" | "postedAt" | "postedAtPrecision" | "commentCount" | "status" | "snoozedUntil" | "freshUntil" | "foundVia" | "qualifiedBy" | "publishedAt"
  > &
    Partial<Pick<PlacementTargetRecord, "kind" | "createdAt" | "foundAt">>,
  now: number,
  /**
   * `full`: the open item's words ("posted at least 2 months ago · found
   * Nov 10") instead of the list's ("2 months+ · found 3d ago"). `found`:
   * whether to say when it was found, when the caller knows better than
   * the status it passes.
   */
  options: { full?: boolean; found?: boolean } = {}
): string {
  const parts = [surfaceLabel(target.surface)];
  const who = bylineParts(target.community, target.author)[0]?.replace(/^by /, "");
  if (who && who.toLowerCase() !== surfaceLabel(target.surface).toLowerCase()) parts.push(who);
  if (target.status === "published_manually") {
    const posted = ageLabel(target.publishedAt, null, now);
    if (posted) parts.push(`posted ${posted}`);
    return parts.join(" · ");
  }
  const found = options.found ?? showsFound(target);
  if (options.full) {
    parts.push(postedPhrase(target.postedAt, target.postedAtPrecision, now));
  } else {
    const age = ageLabel(target.postedAt, target.postedAtPrecision, now);
    if (age) parts.push(age);
    else if (found) parts.push("date unknown");
  }
  if (target.commentCount !== null && target.commentCount > 0) parts.push(`${target.commentCount} comments`);
  const foundAt = found ? (options.full ? foundDay(target.foundAt ?? target.createdAt) : foundLabel(target.foundAt ?? target.createdAt, now)) : "";
  if (foundAt) parts.push(foundAt);
  if (isSnoozed(target, now)) parts.push(`snoozed until ${when(target.snoozedUntil)}`);
  else if (isExpired(target, now)) parts.push("expired");
  return parts.join(" · ");
}

/**
 * The line under the author's name on an open item: the platform, the
 * community when it is not the author ("r/SaaS"), how old the post is, its
 * comments. The author is the name above it, so it is not said twice
 * ("@maya_builds" over "X · 3h"); a posted item gives the post's age here
 * and the moment it was answered under the reply.
 */
export function postMeta(
  target: Parameters<typeof rowMeta>[0],
  now: number
): string {
  const handle = authorHandle(target);
  const plain = (value: string) => value.trim().replace(/^(@|u\/)/i, "").toLowerCase();
  const community = handle && target.community && plain(target.community) !== plain(handle) ? target.community : null;
  const meta = rowMeta(
    {
      ...target,
      author: null,
      community,
      // The post's age, not "posted 2h" (that is the reply's, said under it).
      status: target.status === "published_manually" ? "dismissed" : target.status,
    },
    now,
    // A posted reply is about the reply: its post keeps the short age.
    { full: target.status !== "published_manually", found: showsFound(target) }
  );
  // No author: the name above is the platform itself ("Quora"), said once.
  const label = surfaceLabel(target.surface);
  if (!handle && authorAvatar(target).name === label && meta.startsWith(label)) return meta.slice(label.length).replace(/^ · /, "");
  return meta;
}

/** The post in one line for a row, and whether the body under it repeats it. */
export function postLines(target: Pick<PlacementTargetRecord, "title" | "excerpt">): { title: string; body: string | null } {
  const title = target.title.trim();
  const excerpt = target.excerpt?.trim() ?? "";
  if (!excerpt) return { title, body: null };
  // A post on X is stored with its own text as the title, cut at 200: the
  // card printed it twice. The text is shown once, whole. The two are
  // compared with their spacing folded: the title is stored on one line,
  // the text with the post's own line breaks, and a post written one
  // sentence per line was printed twice (2026-11-10).
  const fold = (text: string) => text.replace(/\s+/g, " ").trim();
  const stem = fold(title.replace(/…$/, ""));
  if (stem && fold(excerpt).startsWith(stem)) return { title: excerpt, body: null };
  return { title, body: excerpt };
}

/** A decline's reason without the sentence that lists the buttons: the buttons are on the item. */
export function declineReason(text: string): string {
  return text
    .replace(/^Not drafted:\s*/i, "")
    .replace(/\s*Your call:.*$/i, "")
    .trim();
}

/* ── Keyboard ────────────────────────────────────────────────────────── */

export type Shortcut = "next" | "previous" | "reply" | "posted" | "fix" | "skip";

const KEYS: Record<string, Shortcut> = { j: "next", k: "previous", r: "reply", p: "posted", f: "fix", s: "skip" };

/**
 * The shortcut a key press means, or null. Never while typing: a key
 * pressed in a field, a text box, a select or anything editable is text,
 * and so is one held with Ctrl, Alt or Cmd (the browser's own shortcuts) or
 * typed through an input method.
 */
export function shortcutFor(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  target?: unknown;
}, page: { dialogOpen?: boolean } = {}): Shortcut | null {
  // A dialog on top (the link sheet after I posted it) owns the keyboard:
  // Enter and Escape are its own, and J/K/R/P/F/S press nothing behind it.
  if (page.dialogOpen) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = (target?.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return null;
  return KEYS[event.key.toLowerCase()] ?? null;
}

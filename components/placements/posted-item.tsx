"use client";

import { useState, type ReactNode } from "react";
import { ClipboardPaste, ExternalLink, Loader2 } from "lucide-react";
import type { PlacementTargetRecord } from "@/lib/placements/read";
import { postedReplyText, type LinkMatch } from "@/lib/placements/link-match";
import { PASTE_BLOCKED, PASTE_NO_LINK, linkFromClipboard, linksFromPaste, readClipboard } from "@/lib/placements/paste";
import { checkPublishedUrl, missingPublishedLink, publishedUrlExample } from "@/lib/placements/published-url";
import { metricsLine } from "@/lib/placements/reply-metrics";
import { REMOVED_REASON_MAX, REMOVED_REASON_PRESETS, isRemoved } from "@/lib/placements/removed";
import { lookingLine, stoppedLine, type LinkFinding } from "@/lib/placements/reply-link";
import { surfaceLabel } from "@/lib/placements/surfaces";
import { cn } from "@/lib/utils";
import { dayLabel, rowMeta } from "@/components/placements/reply-logic";
import { PostText } from "@/components/placements/reply-item";
import { BusyLabel, CHIP, FIELD, PRIMARY, Problem } from "@/components/placements/ui";
import { X_HANDLE_HINT, XHandleField } from "@/components/placements/x-handle-field";
import {
  AuthorAvatar,
  BusinessAvatar,
  PostHeader,
  PostReferences,
  ReplyHeader,
  ThreadSide,
  type BusinessIdentity,
} from "@/components/placements/post-preview";

/**
 * A posted reply, and the link to it.
 *
 * Posted is the end of the line: what was posted lives on the other site
 * now. The item shows the words that went out (read back from X when they
 * could be, else the draft that was marked as posted), so the person can
 * tell which of their replies this is, and asks for the reply's link when
 * it has none: without it the reply cannot be measured. "Paste link" reads
 * the clipboard and saves in one tap when the link can belong to this reply
 * (`checkPublishedUrl`, the check the server runs too).
 *
 * Until 2026-11-10 every posted card carried an amber box with a title, a
 * label, a field, a button and two lines of explanation. The explanation is
 * said once now, on the box above the list (`LinkBox`).
 *
 * Since 2026-11-13 GTF looks for the link of a reply on X by itself
 * (lib/placements/reply-link.ts). While it looks, the card says so and when
 * it stops, and Paste link stays a quiet chip; once it stops, or where it
 * does not look, the paste field is as before. A link it found says "link
 * found on X" beside the date; the person can replace it like any link.
 */

/**
 * One tap: the clipboard's link, checked for this reply, then saved. A
 * refused clipboard, no link in it, or a link that is not this reply's are
 * said in words; nothing is saved.
 */
export async function pasteLinkFor(io: {
  target: { surface: string; url: string };
  read: () => Promise<string | null>;
  save: (url: string) => Promise<string | null>;
}): Promise<string | null> {
  const clip = await io.read();
  if (clip === null) return PASTE_BLOCKED;
  const link = linkFromClipboard(clip);
  if (!link) return PASTE_NO_LINK;
  const check = checkPublishedUrl(link, io.target);
  if (!check.ok) return check.error;
  return io.save(check.url);
}

/** The Paste link button of one posted reply: on its row, and on the open item. */
export function PasteLinkButton({
  target,
  busy,
  primary = false,
  onSave,
  onProblem,
}: {
  target: Pick<PlacementTargetRecord, "surface" | "url">;
  busy: boolean;
  primary?: boolean;
  onSave: (url: string) => Promise<string | null>;
  onProblem: (problem: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <button
      type="button"
      disabled={busy || saving}
      onClick={async () => {
        setSaving(true);
        onProblem(null);
        try {
          onProblem(await pasteLinkFor({ target, read: readClipboard, save: onSave }));
        } finally {
          setSaving(false);
        }
      }}
      aria-busy={saving || undefined}
      className={primary ? PRIMARY : cn(CHIP, "font-medium text-foreground")}
    >
      {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ClipboardPaste className="h-4 w-4" aria-hidden="true" />} Paste link
    </button>
  );
}

export interface PostedItemProps {
  target: PlacementTargetRecord;
  /** The page's clock, for the post's age beside its author. */
  now: number;
  /** Who answered: the business's name and site, for the picture beside the reply. */
  business?: BusinessIdentity;
  /** At the right of the post's header: Close on a phone, Open post in the pane. */
  headerEnd?: ReactNode;
  aeoQueries: Array<{ id: string; query: string }>;
  busy: boolean;
  /** Whether GTF is looking for the reply's link on X (`linkFinding`); null or absent when it has its link. */
  finding?: LinkFinding | null;
  /** The link to the person's own reply. Null once saved, else the server's sentence. */
  onSetPublishedUrl: (publishedUrl: string) => Promise<string | null>;
  onMarkRemoved?: (reason: string | undefined) => Promise<string | null>;
  onUnmarkRemoved?: () => Promise<string | null>;
  /**
   * Ask for the site's X account under a reply on X with no link
   * ("Your X account", XHandleField): the page's `askXHandle`, true while
   * the platform reads X and GTF does not know the account.
   */
  askXHandle?: boolean;
  /** Called once the account is saved, so the page reloads what GTF now does. */
  onXHandleSaved?: () => void;
}

export function PostedItem({
  target,
  now,
  business,
  headerEnd,
  aeoQueries,
  busy,
  finding = null,
  onSetPublishedUrl,
  onMarkRemoved,
  onUnmarkRemoved,
  askXHandle = false,
  onXHandleSaved,
}: PostedItemProps) {
  const removed = isRemoved(target);
  const missing = missingPublishedLink(target);
  const reply = postedReplyText(target);
  const [problem, setProblem] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const undo = async () => {
    if (!onUnmarkRemoved || undoing) return;
    setUndoing(true);
    setProblem(null);
    try {
      setProblem(await onUnmarkRemoved());
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="space-y-3">
      <ThreadSide avatar={<AuthorAvatar target={target} />} line>
        <PostHeader target={target} now={now} end={headerEnd} />
        <PostText target={target} />
        <PostReferences target={target} now={now} />
      </ThreadSide>
      <ThreadSide avatar={<BusinessAvatar business={business} />}>
      <ReplyHeader business={business} />
      {reply && <ReplyText text={reply} />}
      <p className="text-xs text-muted-foreground">
        Posted{target.publishedAt ? ` ${dayLabel(target.publishedAt)}` : ""}
        {target.publishedUrl && target.linkSource === "found_on_x" ? " · link found on X" : ""}
        {target.publishedNote ? ` · ${target.publishedNote}` : ""}
        {removed && (
          <>
            {" "}
            · Removed{target.removedReason ? `: ${target.removedReason}` : ""}, marked {dayLabel(target.removedAt)}
          </>
        )}
        {target.aeoQueryId && <> · AI Visibility query &ldquo;{aeoQueries.find((q) => q.id === target.aeoQueryId)?.query ?? "…"}&rdquo;</>}
      </p>
      {/* X's own public counters on the day they were read: one quiet line, only when read. */}
      {target.metrics && <p className="text-xs text-muted-foreground">{metricsLine(target.metrics, new Date(now))}</p>}

      {missing &&
        (finding?.state === "looking" ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              {lookingLine(finding.stopsBy, now)}
            </p>
            <PasteLinkButton target={target} busy={busy} onSave={onSetPublishedUrl} onProblem={setProblem} />
          </>
        ) : (
          <>
            {finding?.state === "stopped" && <p className="text-sm text-muted-foreground">{stoppedLine(finding.outcome)}</p>}
            <PasteLinkButton target={target} busy={busy} primary onSave={onSetPublishedUrl} onProblem={setProblem} />
            <TypedLink target={target} busy={busy} onSubmit={onSetPublishedUrl} />
          </>
        ))}
      {problem && <Problem>{problem}</Problem>}
      {missing && askXHandle && target.surface === "x" && !removed && (
        <XHandleField hint={X_HANDLE_HINT} onSaved={() => onXHandleSaved?.()} />
      )}

      {/* One row: the primary and the quiet actions beside it. On a phone
          the primary is as wide as the row and the others wrap under it. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {target.publishedUrl && (
          <a href={target.publishedUrl} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Your reply
          </a>
        )}
        <a href={target.url} target="_blank" rel="noopener noreferrer" className={CHIP}>
          Open post
        </a>
        {removed
          ? onUnmarkRemoved && (
              <button type="button" disabled={busy || undoing} aria-busy={undoing || undefined} onClick={() => void undo()} className={CHIP}>
                <BusyLabel busy={undoing}>Undo: it is still up</BusyLabel>
              </button>
            )
          : onMarkRemoved && <MarkRemoved busy={busy} onSubmit={onMarkRemoved} />}
      </div>
      </ThreadSide>
    </div>
  );
}

/**
 * The words that went out. Enough of them to tell which reply this is (four
 * lines); a tap shows the rest, so a long answer does not push Paste link
 * off the screen.
 */
function ReplyText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((current) => !current)}
      aria-expanded={open}
      className={cn("block w-full whitespace-pre-wrap break-words text-left text-[17px] leading-relaxed text-foreground", !open && "line-clamp-4")}
    >
      {text}
    </button>
  );
}

/** The link typed or pasted by hand, for a browser that will not hand over the clipboard. */
function TypedLink({
  target,
  busy,
  onSubmit,
}: {
  target: Pick<PlacementTargetRecord, "surface" | "url">;
  busy: boolean;
  onSubmit: (publishedUrl: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const check = checkPublishedUrl(value, target);
  const problem = !check.ok && value.trim() ? check.error : null;

  return (
    <form
      noValidate
      className="space-y-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!check.ok || saving) return;
        setSaving(true);
        setRefused(null);
        try {
          setRefused(await onSubmit(check.url));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="flex gap-2">
        <input
          type="url"
          inputMode="url"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setRefused(null);
          }}
          placeholder={publishedUrlExample(target.surface)}
          aria-label={`Link to your reply${target.surface === "web" ? "" : ` on ${surfaceLabel(target.surface)}`}`}
          aria-invalid={Boolean(problem || refused)}
          className={FIELD}
        />
        <button type="submit" disabled={!check.ok || saving || busy} aria-busy={saving || undefined} className={cn(CHIP, "rounded-lg")}>
          <BusyLabel busy={saving}>Save</BusyLabel>
        </button>
      </div>
      {(refused || problem) && <Problem>{refused ?? problem}</Problem>}
    </form>
  );
}

/**
 * "It was removed": a chip that opens, in place, the reasons a thumb can
 * tap and a field for one's own, at most REMOVED_REASON_MAX characters. No
 * dialog. The reason is optional; the record is what counts.
 */
export function MarkRemoved({
  busy,
  defaultOpen = false,
  onSubmit,
}: {
  busy: boolean;
  defaultOpen?: boolean;
  onSubmit: (reason: string | undefined) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} aria-expanded={false} className={CHIP}>
        It was removed
      </button>
    );
  }

  return (
    <form
      noValidate
      className="w-full space-y-2 pt-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        setRefused(null);
        try {
          const error = await onSubmit(reason.trim() || undefined);
          setRefused(error);
          if (!error) setOpen(false);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Why it was removed">
        {REMOVED_REASON_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={reason === preset}
            disabled={saving}
            onClick={() => setReason(reason === preset ? "" : preset)}
            className={cn(CHIP, "h-auto whitespace-normal py-2 text-left", reason === preset && "border-foreground/50 bg-muted/60")}
          >
            {preset}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setRefused(null);
        }}
        maxLength={REMOVED_REASON_MAX}
        readOnly={saving}
        placeholder="Or say why (optional)"
        aria-label="Why it was removed (optional)"
        className={FIELD}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="submit" disabled={busy || saving} aria-busy={saving || undefined} className={cn(CHIP, "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary")}>
          <BusyLabel busy={saving}>Mark as removed</BusyLabel>
        </button>
        <button type="button" disabled={saving} onClick={() => setOpen(false)} className={CHIP}>
          Cancel
        </button>
      </div>
      {refused ? <Problem>{refused}</Problem> : <p className="text-xs text-muted-foreground">It stays under Removed and stops asking for its link.</p>}
    </form>
  );
}

/** What the box says once the pasted links were matched and saved. */
export interface LinkBoxResult {
  saved: number;
  /** Links that need the person: which reply is it? */
  picks: Array<Extract<LinkMatch, { kind: "pick" }>>;
  /** Links that went nowhere, each with the reason. */
  refused: Array<{ link: string; error: string }>;
}

/** A link short enough for one line: the host and the end of the path. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname.replace(/\/+$/, "");
    const tail = path.length > 22 ? `…${path.slice(-20)}` : path;
    return `${url.hostname.replace(/^www\./, "")}${tail}`;
  } catch {
    return link.slice(0, 40);
  }
}

/**
 * "Paste your reply links": one place for the links of the replies posted
 * earlier, instead of one field per card. Each link is sent to the reply it
 * belongs to (lib/placements/link-match.ts): saved at once when that is
 * sure, asked about with the candidates in one tap when it is not, and
 * never guessed.
 */
export function LinkBox({
  busy,
  result,
  candidates,
  looking = 0,
  now,
  onLinks,
  onPick,
  onDismissPick,
}: {
  busy: boolean;
  /** Of the replies listed, how many GTF is still looking for on X by itself. */
  looking?: number;
  result: LinkBoxResult | null;
  /** The posted replies still missing their link, to show a pick's candidates. */
  candidates: readonly PlacementTargetRecord[];
  now: number;
  /** Matches the links and saves the sure ones. */
  onLinks: (links: string[], over: number) => Promise<void>;
  /** The person says which reply a link belongs to. Null once saved, else the server's sentence. */
  onPick: (link: string, targetId: string) => Promise<string | null>;
  onDismissPick: (link: string) => void;
}) {
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pickError, setPickError] = useState<Record<string, string>>({});
  // The candidate being saved ("<link> <id>"), so its row turns while it saves.
  const [picking, setPicking] = useState<string | null>(null);

  const submit = async (text: string) => {
    const { links, over } = linksFromPaste(text);
    if (links.length === 0) {
      setNote(PASTE_NO_LINK);
      return;
    }
    setWorking(true);
    setNote(null);
    try {
      await onLinks(links, over);
      setValue("");
    } finally {
      setWorking(false);
    }
  };

  const paste = async () => {
    const clip = await readClipboard();
    if (clip === null) {
      setNote(PASTE_BLOCKED);
      return;
    }
    await submit(clip);
  };

  return (
    <div className="space-y-2 border-b border-amber-300/70 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-sm font-medium">Paste your reply links</p>
      {looking > 0 && (
        <p className="text-xs text-muted-foreground">
          {looking === 1 ? "GTF is looking for 1 of these on X by itself." : `GTF is looking for ${looking} of these on X by itself.`}
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value);
        }}
      >
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
          }}
          placeholder="One or many, we match them"
          aria-label="Links to your replies"
          className={cn(FIELD, "flex-1")}
        />
        {value.trim() ? (
          <button type="submit" disabled={busy || working} aria-busy={working || undefined} className={cn(PRIMARY, "w-auto shrink-0")}>
            <BusyLabel busy={working}>Match</BusyLabel>
          </button>
        ) : (
          <button type="button" disabled={busy || working} onClick={() => void paste()} className={cn(PRIMARY, "w-auto shrink-0")}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ClipboardPaste className="h-4 w-4" aria-hidden="true" />} Paste
          </button>
        )}
      </form>
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {result && (
        <div className="space-y-2 text-xs" role="status">
          {result.saved > 0 && <p className="font-medium">{result.saved === 1 ? "1 link saved." : `${result.saved} links saved.`}</p>}
          {result.refused.map((r) => (
            <p key={r.link} className="text-red-700 dark:text-red-400">
              <span className="font-medium">{shortLink(r.link)}</span>: {r.error}
            </p>
          ))}
          {result.picks.map((pick) => {
            const options = pick.candidateIds
              .map((id) => candidates.find((c) => c.id === id))
              .filter((c): c is PlacementTargetRecord => Boolean(c));
            return (
              <div key={pick.link} className="space-y-1">
                <p>
                  <span className="font-medium">{shortLink(pick.link)}</span>: which reply is it?
                </p>
                <div className="space-y-1">
                  {options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      disabled={busy || picking !== null}
                      aria-busy={picking === `${pick.link} ${option.id}` || undefined}
                      onClick={async () => {
                        setPicking(`${pick.link} ${option.id}`);
                        try {
                          const error = await onPick(pick.link, option.id);
                          setPickError((current) => ({ ...current, [pick.link]: error ?? "" }));
                        } finally {
                          setPicking(null);
                        }
                      }}
                      className="relative flex min-h-11 w-full items-center gap-2 rounded-lg border border-foreground/15 bg-background px-3 py-1.5 text-left hover:bg-muted/60 md:min-h-9"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-muted-foreground">{rowMeta(option, now)}</span>
                        <span className="block truncate text-sm">{postedReplyText(option) ?? option.title}</span>
                      </span>
                      {/* The spinner sits in the space the row already has: nothing moves. */}
                      <Loader2
                        className={cn("h-4 w-4 shrink-0 animate-spin text-muted-foreground", picking !== `${pick.link} ${option.id}` && "invisible")}
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                  <button type="button" onClick={() => onDismissPick(pick.link)} className={CHIP}>
                    None of these
                  </button>
                </div>
                {pickError[pick.link] && <Problem>{pickError[pick.link]}</Problem>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

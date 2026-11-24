"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Check, CheckCircle2, ExternalLink, Info, Loader2, Reply, Send, XCircle } from "lucide-react";
import type { AuditCheck } from "@/lib/placements/audit";
import { REASON_MAX } from "@/lib/placements/feedback";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";
import { variantCarriesLink } from "@/lib/placements/link";
import { xReplyIntentUrl } from "@/lib/placements/intent";
import { xReplyAllowance } from "@/lib/placements/x-reply-allowed";
import { surfaceLabel } from "@/lib/placements/surfaces";
import { draftWaitMessage, type DraftFailureKind } from "@/lib/placements/draft-progress";
import { OPEN_STATUSES, isHumanWritten, preferredDraft, takesReply } from "@/lib/placements/workflow";
import { aiCitationLine } from "@/lib/placements/ai-citation";
import { MEDIA_UNREAD_LINE, imageUrlOf, showsUnreadImage } from "@/lib/placements/media";
import { cn } from "@/lib/utils";
import {
  FIX_IT_START,
  FIX_PLACEHOLDER,
  FIX_PRESETS,
  auditSummary,
  copyText,
  correctThenApply,
  declineReason,
  fixIt,
  fixLinkLabel,
  isAdvisoryCheck,
  noteProblem,
  openIn,
  ownPath,
  postOnXThenFallback,
  postLines,
  promoteNote,
  replyLabel,
  replyThenOpen,
  reserveTab,
  type CorrectionResult,
  type PostOnXResult,
  type PromoteNoteResult,
  type SaveDraftResult,
} from "@/components/placements/reply-logic";
import { BusyLabel, CHIP, FIELD, MoreMenu, PRIMARY, Problem, type MenuItem } from "@/components/placements/ui";
import {
  ConfirmFacts,
  FactAdded,
  confirmableSentences,
  type AddFactResult,
  type RemoveFactResult,
} from "@/components/placements/confirm-fact";
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
 * The open item of the Replies queue, for a post that can still be answered
 * (and for one that was skipped, filtered out or not sorted yet).
 *
 * The draft is the largest text. Above it the post, once, two lines until
 * tapped. Under it one primary button: Reply on X (or on the site the
 * thread is on), which becomes I posted it, in the same place, once the
 * reply is out. Then the notes the owner gives most as one-tap chips, Skip,
 * and a ⋯ menu for the rest (Copy, Start over, Snooze, Open post, Voice).
 * The checks are one quiet mark when they pass and one line each when they
 * do not. Every button here copies, opens the other site, or records what
 * the person did, with one exception: on a post on X that mentions or quotes
 * the X account the site connected, the primary button is Post on X, and one
 * press posts that reply from that account (the only post GTF makes, and
 * only on that press). Every other post keeps Reply on X.
 *
 * Until 2026-11-10 this was a card with twelve controls that opened by
 * itself for every draft (docs/PLACEMENTS.md, "The queue").
 */

const VARIANT_LABEL: Record<string, string> = {
  short_comment: "Reply",
  detailed_answer: "Long reply",
  article_draft: "Post",
  github_issue: "Issue comment",
  github_pr_proposal: "PR proposal",
};

/** What J/K's siblings press on the open item: set by the item, called by the page's shortcuts. */
export interface ItemActions {
  reply?: () => void;
  posted?: () => void;
  fix?: () => void;
  skip?: () => void;
}

export interface ReplyItemProps {
  target: PlacementTargetRecord;
  /** The page's clock, for the post's age beside its author. */
  now: number;
  /** Who answers: the business's name and site, for the picture beside the draft. */
  business?: BusinessIdentity;
  /** At the right of the post's header: Close on a phone, Open post in the pane. */
  headerEnd?: ReactNode;
  /** An action on this item is in flight: its buttons wait. */
  busy: boolean;
  /** Which move the item is waiting on ("dismiss", "snooze", "reopen", …): its button turns. */
  pending?: string | null;
  /** A draft is being written for this item right now. */
  writing?: boolean;
  /** How the last draft ended, when it ended without text. */
  note?: { tone: "info" | "error"; text: string; kind?: DraftFailureKind } | null;
  /** Reply was tapped: the primary button is now I posted it. Held by the page, so it survives closing the item. */
  replied: boolean;
  onRepliedChange: (replied: boolean) => void;
  onDraft: () => void;
  onDraftAnyway?: () => void;
  onAction: (action: "dismiss" | "snooze" | "reopen") => void;
  /** "I posted it": null once recorded, else the server's sentence. */
  onMarkPublished: (extra: { placementId?: string | null }) => Promise<string | null>;
  onSaveDraft: (draftId: string, body: string, linkUrl: string | null) => Promise<SaveDraftResult>;
  onSaveOwnReply: (body: string) => Promise<SaveDraftResult>;
  onCorrectDraft: (draftId: string, reason: string, body: string | null) => Promise<CorrectionResult>;
  onPromoteNote: (feedbackId: string) => Promise<PromoteNoteResult>;
  /** "It's true: add to About you" on a flagged sentence. Absent: the action is not offered. */
  onAddFact?: (fact: string) => Promise<AddFactResult>;
  /** Its Undo: the exact sentence out, while About you is as the add left it. */
  onRemoveFact?: (fact: string, aboutYou: string) => Promise<RemoveFactResult>;
  writerUseRecorded?: boolean;
  /** Told what the keyboard shortcuts press on this item, as it stands now. */
  onActions?: (actions: ItemActions) => void;
  /** The X account this site posts from, without @; null or absent when none is connected. */
  xPostingUsername?: string | null;
  /** Post on X: posts the draft from that account. Absent: never offered. */
  onPostOnX?: (draftId: string) => Promise<PostOnXResult>;
}

export function ReplyItem({
  target,
  now,
  business,
  headerEnd,
  busy,
  pending = null,
  writing = false,
  note = null,
  replied,
  onRepliedChange,
  onDraft,
  onDraftAnyway,
  onAction,
  onMarkPublished,
  onSaveDraft,
  onSaveOwnReply,
  onCorrectDraft,
  onPromoteNote,
  onAddFact,
  onRemoveFact,
  writerUseRecorded = true,
  onActions,
  xPostingUsername = null,
  onPostOnX,
}: ReplyItemProps) {
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const draft = target.drafts.find((d) => d.id === activeDraft) ?? preferredDraft(target.drafts);
  const canAct = OPEN_STATUSES.includes(target.status);
  // A list article takes no reply: nothing to draft, write or mark as posted.
  const listicle = !takesReply(target.kind);
  const canDraft = canAct && !listicle;
  // A note corrects the drafter: offered on a model's draft of an open post.
  const correctable = canAct && !writing && draft !== null && !isHumanWritten(draft);

  const markPosted = async () => {
    if (posting || !draft) return;
    setPosting(true);
    setPostError(null);
    try {
      setPostError(await onMarkPublished({ placementId: draft.id }));
    } finally {
      setPosting(false);
    }
  };

  const skip = canAct || target.status === "discovered" ? () => onAction("dismiss") : undefined;
  const menu: MenuItem[] = [
    ...(canDraft && draft && !writing ? [{ label: "Start over", onSelect: onDraft, disabled: busy }] : []),
    ...(canAct ? [{ label: "Snooze a week", onSelect: () => onAction("snooze"), disabled: busy, pending: pending === "snooze" }] : []),
    { label: "Open post", href: target.url },
    ...(canDraft ? [{ label: "Voice", href: "/settings/voice", external: false }] : []),
  ];

  // What the keyboard presses when there is no draft on the item.
  useEffect(() => {
    if (!onActions || draft) return;
    onActions({ skip });
    return () => onActions({});
  });

  const failure = !writing && note?.tone === "error" ? note : null;
  // The item reads as a thread when there is a reply under the post: a
  // draft, one being written, or the person's own being typed.
  const own = canDraft && !writing && !draft && ownOpen;
  const threaded = writing || Boolean(draft) || own;

  return (
    <div className="space-y-3">
      <ThreadSide avatar={<AuthorAvatar target={target} />} line={threaded}>
      <PostHeader target={target} now={now} end={headerEnd} />
      <PostText target={target} />
      <PostMedia target={target} />
      <PostReferences target={target} now={now} />
      {target.aiCitation && (
        // Why a visibility run put this page here: one sampled answer, per engine.
        <p className="text-xs text-muted-foreground">{aiCitationLine(target.aiCitation)}</p>
      )}

      {target.status === "rejected" && (target.qualifyReason || target.qualifiedBy?.startsWith("rules:")) && (
        <p className="text-sm text-muted-foreground">
          Filtered out
          {target.qualifiedBy?.startsWith("rules:") && <> (rule: {target.qualifiedBy.slice(6)})</>}
          {target.qualifyReason && <>: {target.qualifyReason}</>}
        </p>
      )}
      {target.status === "dismissed" && target.dismissedReason && (
        <p className="text-sm text-muted-foreground">Skipped: {target.dismissedReason}</p>
      )}

      {canDraft && !writerUseRecorded && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Drafts speak only from what you recorded about yourself. Add one true sentence under{" "}
          <Link href="/settings/voice" className="underline underline-offset-2">
            Voice
          </Link>
          .
        </p>
      )}

      {failure && canDraft && !draft && (
        <p role="status" className="text-sm text-red-700 dark:text-red-300">
          {failure.kind === "declined" ? declineReason(failure.text) : failure.text}
        </p>
      )}

      {!threaded && (
        <ItemActions
          target={target}
          busy={busy}
          canAct={canAct}
          canDraft={canDraft}
          listicle={listicle}
          failure={failure}
          menu={menu}
          skip={skip}
          onDraft={onDraft}
          onDraftAnyway={onDraftAnyway}
          onAction={onAction}
          onWriteOwn={() => setOwnOpen(true)}
          pending={pending}
        />
      )}
      </ThreadSide>

      {threaded && (
        <ThreadSide avatar={<BusinessAvatar business={business} />}>
          <ReplyHeader business={business} />
          {writing ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {note?.tone === "info" ? note.text : draftWaitMessage()}
            </p>
          ) : draft ? (
            <DraftBlock
          key={draft.id}
          target={target}
          draft={draft}
          drafts={target.drafts}
          onPickDraft={setActiveDraft}
          busy={busy || posting}
          canAct={canAct}
          replied={replied}
          onRepliedChange={onRepliedChange}
          onMarkPosted={() => void markPosted()}
          posting={posting}
          onSave={onSaveDraft}
          onCorrect={correctable ? (reason, body) => onCorrectDraft(draft.id, reason, body) : undefined}
          onPromote={onPromoteNote}
          onAddFact={onAddFact}
          onRemoveFact={onRemoveFact}
          now={now}
          onSkip={skip}
          skipping={pending === "dismiss"}
          menu={menu}
          onActions={onActions}
          xPostingUsername={xPostingUsername}
          onPostOnX={onPostOnX}
        />
          ) : (
            <OwnReply
              target={target}
              onSave={onSaveOwnReply}
              onReplied={() => onRepliedChange(true)}
              onCancel={() => setOwnOpen(false)}
            />
          )}
        </ThreadSide>
      )}

      {postError && <Problem>{postError}</Problem>}
    </div>
  );
}

/**
 * The actions of an item with no reply under its post: Draft it (or Write
 * it anyway after a decline), Open the article for a list article, Bring
 * back or Open post on one that is closed.
 */
function ItemActions({
  target,
  busy,
  canAct,
  canDraft,
  listicle,
  failure,
  menu,
  skip,
  onDraft,
  onDraftAnyway,
  onAction,
  onWriteOwn,
  pending,
}: {
  pending: string | null;
  target: PlacementTargetRecord;
  busy: boolean;
  canAct: boolean;
  canDraft: boolean;
  listicle: boolean;
  failure: { kind?: DraftFailureKind } | null;
  menu: MenuItem[];
  skip?: () => void;
  onDraft: () => void;
  onDraftAnyway?: () => void;
  onAction: (action: "dismiss" | "snooze" | "reopen") => void;
  onWriteOwn: () => void;
}) {
  return listicle && canAct ? (
        <>
          <p className="text-sm text-muted-foreground">
            A list article has no reply box. Ask its author to consider you for the list: nothing is written or sent for
            you, and nobody has checked that the author takes suggestions.
          </p>
          <Actions
            primary={
              <a href={target.url} target="_blank" rel="noopener noreferrer" className={MAIN}>
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open the article
              </a>
            }
            menu={menu.filter((item) => item.label !== "Open post")}
          >
            {skip && (
              <SkipChip busy={busy} skipping={pending === "dismiss"} onSkip={skip} />
            )}
          </Actions>
        </>
      ) : canDraft ? (
            <Actions
              primary={
                failure?.kind === "declined" && onDraftAnyway ? (
                  <button type="button" disabled={busy} onClick={onDraftAnyway} className={MAIN}>
                    Write it anyway
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={onDraft} className={MAIN}>
                    Draft it
                  </button>
                )
              }
              menu={menu}
            >
              <button type="button" onClick={onWriteOwn} className={CHIP}>
                Write my own
              </button>
              {skip && (
                <SkipChip busy={busy} skipping={pending === "dismiss"} onSkip={skip} />
              )}
            </Actions>
      ) : !canAct ? (
        <Actions
          primary={
            target.status === "rejected" || target.status === "dismissed" ? (
              <button type="button" disabled={busy} aria-busy={pending === "reopen" || undefined} onClick={() => onAction("reopen")} className={MAIN}>
                <BusyLabel busy={pending === "reopen"}>Bring back</BusyLabel>
              </button>
            ) : (
              <a href={target.url} target="_blank" rel="noopener noreferrer" className={MAIN}>
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open post
              </a>
            )
          }
          menu={target.status !== "discovered" ? menu : undefined}
        >
          {skip && (
            <SkipChip busy={busy} skipping={pending === "dismiss"} onSkip={skip} />
          )}
        </Actions>
      ) : null;
}

/** Skip, with its spinner while the skip is being recorded. */
function SkipChip({ busy, skipping, onSkip }: { busy: boolean; skipping: boolean; onSkip?: () => void }) {
  return (
    <button type="button" disabled={busy} aria-busy={skipping || undefined} onClick={onSkip} className={CHIP}>
      <BusyLabel busy={skipping}>Skip</BusyLabel>
    </button>
  );
}

/**
 * The primary button, the ⋯ menu and the chips of one state. On a phone the
 * button takes the row with ⋯ at its end and the chips sit under it; from
 * `md` up they are one row, the button first and ⋯ last.
 */
function Actions({
  primary,
  menu,
  children,
  stay = false,
}: {
  primary: React.ReactNode;
  menu?: MenuItem[];
  children?: React.ReactNode;
  /**
   * Under a long draft: the row stays at the bottom of the scrolling area
   * while the draft is read, so the next step is never below the fold. It
   * is `sticky` inside the list, in the flow, not a bar fixed to the screen.
   */
  stay?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", stay && "sticky bottom-0 z-10 -my-2 bg-background py-2")}>
      {primary}
      {menu && <MoreMenu items={menu} className="md:order-last" />}
      {children}
    </div>
  );
}

/** The primary button inside `Actions`: as wide as the row allows on a phone, its own width from `md` up. */
const MAIN = cn(PRIMARY, "w-auto min-w-0 flex-1 basis-[calc(100%-3.5rem)] md:flex-none md:basis-auto");

/**
 * The post, once. A post on X is stored with its own text as the title, and
 * the card printed both: here it is two muted lines, and a tap shows it all.
 * A thread with a real title keeps the title, with its text under it.
 */
export function PostText({ target }: { target: Pick<PlacementTargetRecord, "title" | "excerpt"> }) {
  const [open, setOpen] = useState(false);
  const { title, body } = postLines(target);
  return (
    <button
      type="button"
      onClick={() => setOpen((current) => !current)}
      aria-expanded={open}
      className="flex min-h-11 w-full flex-col justify-center text-left text-sm text-muted-foreground"
    >
      <span className={cn("block whitespace-pre-wrap", body ? "font-medium text-foreground/80" : "", !open && "line-clamp-2")}>{title}</span>
      {body && <span className={cn("mt-1 block whitespace-pre-wrap", !open && "line-clamp-2")}>{body}</span>}
    </button>
  );
}

/**
 * The post's first image under its text, small, and a quiet line when the
 * post has an image the draft could not see (lib/placements/media.ts).
 * Only on the open item: the closed rows stay one line. The image is X's
 * own file, loaded lazily with no referrer; a tap opens it full size (a
 * video's still opens the post, where the video plays).
 */
export function PostMedia({
  target,
}: {
  target: Pick<PlacementTargetRecord, "url" | "media" | "mediaUnread" | "drafts">;
}) {
  const [broken, setBroken] = useState(false);
  const first = (target.media ?? []).find((item) => imageUrlOf(item) !== null) ?? null;
  const src = first ? imageUrlOf(first) : null;
  const unread = showsUnreadImage(target);
  if (!src && !unread) return null;
  const href = first?.type === "photo" && src ? src : target.url;
  return (
    <div className="space-y-1">
      {src && !broken && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-block max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element -- X's own image, lazy, no referrer: next/image would proxy someone's picture through our server. */}
          <img
            src={src}
            alt={first?.altText ?? "Image in the post"}
            width={first?.width ?? undefined}
            height={first?.height ?? undefined}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
            className="block h-auto max-h-[200px] w-auto max-w-full rounded-lg border border-foreground/10 bg-muted object-contain md:max-h-64"
          />
        </a>
      )}
      {unread && (
        <p className="text-xs text-muted-foreground">
          {MEDIA_UNREAD_LINE} ·{" "}
          <a href={target.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            Open post
          </a>
        </p>
      )}
    </div>
  );
}

/** A text box as tall as its text: no clipped last line, no empty half. */
function GrowingText({
  value,
  onChange,
  readOnly,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      aria-label={label}
      placeholder={placeholder}
      rows={2}
      className={cn("block w-full resize-none overflow-hidden bg-transparent leading-relaxed focus:outline-none", className)}
    />
  );
}

/** One check: the label, and what was found under it. A note is grey, whatever its status says. */
function CheckLine({ check }: { check: AuditCheck }) {
  const advisory = isAdvisoryCheck(check);
  const Icon = advisory ? Info : check.status === "pass" ? CheckCircle2 : check.status === "warn" ? AlertTriangle : XCircle;
  const color = advisory
    ? "text-muted-foreground"
    : check.status === "pass"
      ? "text-emerald-600 dark:text-emerald-400"
      : check.status === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  return (
    <li className="flex items-start gap-2 text-xs" data-advisory={advisory ? "true" : undefined}>
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", color)} aria-hidden="true" />
      <span className="min-w-0">
        <span className={cn("block font-medium", advisory && "text-muted-foreground")}>
          {advisory && <span className="sr-only">Note: </span>}
          {check.label}
        </span>
        <span className="block text-muted-foreground">{check.detail}</span>
      </span>
    </li>
  );
}

function draftLabel(d: PlacementDraftRecord): string {
  return isHumanWritten(d) ? "Yours" : (VARIANT_LABEL[d.variant] ?? d.variant);
}

function DraftBlock({
  target,
  draft,
  drafts,
  onPickDraft,
  busy,
  canAct,
  replied,
  onRepliedChange,
  onMarkPosted,
  posting,
  onSave,
  onCorrect,
  onPromote,
  onAddFact,
  onRemoveFact,
  now,
  onSkip,
  skipping = false,
  menu,
  onActions,
  xPostingUsername = null,
  onPostOnX,
}: {
  xPostingUsername?: string | null;
  onPostOnX?: (draftId: string) => Promise<PostOnXResult>;
  skipping?: boolean;
  onAddFact?: (fact: string) => Promise<AddFactResult>;
  onRemoveFact?: (fact: string, aboutYou: string) => Promise<RemoveFactResult>;
  now: number;
  target: PlacementTargetRecord;
  draft: PlacementDraftRecord;
  drafts: PlacementDraftRecord[];
  onPickDraft: (id: string) => void;
  busy: boolean;
  canAct: boolean;
  replied: boolean;
  onRepliedChange: (replied: boolean) => void;
  onMarkPosted: () => void;
  posting: boolean;
  onSave: (draftId: string, body: string, linkUrl: string | null) => Promise<SaveDraftResult>;
  onCorrect?: (reason: string, body: string | null) => Promise<CorrectionResult>;
  onPromote: (feedbackId: string) => Promise<PromoteNoteResult>;
  onSkip?: () => void;
  menu: MenuItem[];
  onActions?: (actions: ItemActions) => void;
}) {
  const surface = target.surface;
  const noUrl = !variantCarriesLink(draft.variant, surface);
  const [body, setBody] = useState(draft.body);
  const [linkUrl, setLinkUrl] = useState(draft.linkUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [replying, setReplying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [fix, dispatchFix] = useReducer(fixIt, FIX_IT_START);
  const rewriting = fix.rewriting;
  // The note being rewritten from, so its chip turns while it runs.
  const [asked, setAsked] = useState<string | null>(null);
  const dirty = body !== draft.body || (!noUrl && (linkUrl || null) !== (draft.linkUrl ?? null));
  const blocked = draft.auditStatus === "blocked";
  const { allPassed, flagged } = auditSummary(draft.audit);
  const stopped = blocked && !dirty;

  // A reply on X opens X's own composer, filled in, under the post. No status
  // id in the thread address, or a text too long for an address, and the
  // button falls back to copy-and-open.
  const intentFor = (text: string) =>
    surface === "x" && draft.variant === "short_comment" ? xReplyIntentUrl(target.url, text) : null;

  // Post on X: only where X lets GTF reply from the connected account (the
  // post mentions, quotes or answers it, or is its own), on a short reply
  // the checks did not stop. Everywhere else, today's Reply on X.
  const postable =
    Boolean(onPostOnX && xPostingUsername) &&
    canAct &&
    !stopped &&
    draft.variant === "short_comment" &&
    xReplyAllowance(target, xPostingUsername) !== null;
  const [postingX, setPostingX] = useState(false);
  const [xNote, setXNote] = useState<{ text: string; url: string | null } | null>(null);

  const save = async (): Promise<PlacementDraftRecord | null> => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave(draft.id, body, noUrl ? null : linkUrl.trim() || null);
      if (!result.ok) {
        setSaveError(result.error);
        return null;
      }
      setBody(result.draft.body);
      setLinkUrl(result.draft.linkUrl ?? "");
      return result.draft;
    } finally {
      setSaving(false);
    }
  };

  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const reply = async (anyway: boolean) => {
    if (replying || saving || rewriting) return;
    setReplying(true);
    // Saving takes a round trip, and a browser blocks a tab opened after
    // one: the tab is opened now and pointed at X once the text is saved.
    const reserved = dirty ? reserveTab() : null;
    try {
      const outcome = await replyThenOpen({
        dirty,
        blocked,
        anyway,
        body,
        save,
        urlFor: (text) => intentFor(text) ?? target.url,
        copy: async (text) => {
          if (await copyText(text)) flash();
        },
        open: (url) => openIn(reserved, url),
        then: canAct ? () => onRepliedChange(true) : undefined,
      });
      if (outcome !== "opened") reserved?.close();
    } finally {
      setReplying(false);
    }
  };

  const postX = async () => {
    if (!onPostOnX || postingX || saving || rewriting || replying) return;
    setPostingX(true);
    setXNote(null);
    let fallbackUrl: string | null = null;
    try {
      const outcome = await postOnXThenFallback({
        dirty,
        draftId: draft.id,
        save,
        post: onPostOnX,
        open: (url) => {
          fallbackUrl = url;
          // Still the press's own gesture in most browsers; where the tab is
          // refused, the line under the button carries the same link.
          const opened = window.open(url, "_blank");
          if (opened) {
            opened.opener = null;
            fallbackUrl = null;
          }
        },
      });
      if (outcome.kind === "fell_back") {
        setXNote({ text: outcome.message, url: fallbackUrl });
        if (canAct) onRepliedChange(true);
      } else if (outcome.kind === "failed") {
        setXNote({ text: outcome.message, url: null });
      } else if (outcome.kind === "blocked") {
        setXNote({ text: "A check stopped this draft, so it was not posted. Fix it, or reply on X yourself.", url: null });
      }
    } finally {
      setPostingX(false);
    }
  };

  const submitFix = async (reason: string) => {
    if (!onCorrect || fix.rewriting) return;
    const problem = noteProblem(reason);
    if (problem) {
      dispatchFix({ type: "refused", error: problem });
      return;
    }
    dispatchFix({ type: "submit" });
    setAsked(reason);
    try {
      dispatchFix(
        await correctThenApply({
          reason,
          body,
          correct: onCorrect,
          apply: (saved) => {
            setBody(saved.body);
            setLinkUrl(saved.linkUrl ?? "");
            setSaveError(null);
          },
        })
      );
    } finally {
      setAsked(null);
    }
  };

  // "It's true: add to About you": the fact as About you now holds it, for the Undo.
  const [factAdded, setFactAdded] = useState<{ fact: string; aboutYou: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const addFact = async (fact: string): Promise<string | null> => {
    if (!onAddFact) return null;
    const result = await onAddFact(fact);
    if (!result.ok) return result.error;
    setUndoError(null);
    setFactAdded(result.added ? { fact: result.fact, aboutYou: result.aboutYou } : null);
    // "Check again" on the same text: judged against About you as it is now. Nothing is rewritten.
    await save();
    return null;
  };

  const undoFact = async () => {
    if (!factAdded || !onRemoveFact || undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const result = await onRemoveFact(factAdded.fact, factAdded.aboutYou);
      if (!result.ok) {
        setUndoError(result.error);
        return;
      }
      setFactAdded(null);
      await save();
    } finally {
      setUndoing(false);
    }
  };

  const addToNotes = async () => {
    if (!fix.kept || fix.promoting) return;
    dispatchFix({ type: "promote" });
    dispatchFix(await promoteNote({ feedbackId: fix.kept.feedbackId, promote: onPromote }));
  };

  // What R, P, F and S press, on the item as it stands now.
  useEffect(() => {
    if (!onActions) return;
    onActions({
      reply: () => void (postable ? postX() : reply(stopped)),
      posted: canAct ? onMarkPosted : undefined,
      fix: onCorrect ? () => dispatchFix({ type: "toggle" }) : undefined,
      skip: onSkip,
    });
    return () => onActions({});
  });

  const failing = flagged.filter((check) => check.status === "fail");
  const waiting = busy || saving || replying || rewriting || postingX;
  const errorHref = ownPath(fix.error?.href ?? null);
  const fullMenu: MenuItem[] = [
    { label: "Copy", onSelect: () => void copyText(body).then((ok) => ok && flash()) },
    // Post on X is the primary: posting it yourself stays one tap away.
    ...(postable ? [{ label: "Reply on X yourself", onSelect: () => void reply(stopped), disabled: waiting }] : []),
    ...(canAct && !replied ? [{ label: "I posted it", onSelect: onMarkPosted, disabled: waiting, pending: posting }] : []),
    ...menu,
  ];

  return (
    <div className="space-y-3">
      {drafts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Drafts">
          {drafts.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={d.id === draft.id}
              onClick={() => onPickDraft(d.id)}
              className={cn(CHIP, d.id === draft.id ? "border-foreground/50 font-medium text-foreground" : "text-muted-foreground")}
            >
              {draftLabel(d)}
            </button>
          ))}
        </div>
      )}

      <GrowingText
        value={body}
        onChange={setBody}
        // Being rewritten from a note: typing now would be overwritten.
        readOnly={rewriting}
        label="Your reply"
        className={cn(
          "-mx-2 w-[calc(100%+1rem)] cursor-text rounded-md px-2 py-1 text-[17px] text-foreground hover:bg-foreground/[0.03] focus:bg-foreground/[0.04]",
          rewriting && "opacity-50"
        )}
      />

      {!noUrl && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>Page on your site to link (empty: the site itself)</span>
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" className={FIELD} />
        </label>
      )}

      {/* The checks: one quiet mark when they pass, one line each when they do not. */}
      {allPassed && !dirty ? (
        <button
          type="button"
          onClick={() => setShowChecks((all) => !all)}
          aria-expanded={showChecks}
          className="-my-2 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-emerald-700 md:my-0 md:min-h-0 dark:text-emerald-400"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Checked
        </button>
      ) : (
        !dirty && (
          <div role={stopped ? "alert" : undefined} className="space-y-1">
            {flagged.length === 0 ? (
              <p className="text-xs text-muted-foreground">No check on record.</p>
            ) : (
              flagged.map((check) => (
                <div key={check.id} className="space-y-1">
                  <p className={cn("text-xs", check.status === "fail" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                    <span className="font-medium">{check.status === "fail" ? "Check failed" : "Check"}: </span>
                    {check.label}. {check.detail}
                  </p>
                  {onAddFact && (
                    <ConfirmFacts sentences={confirmableSentences(check, draft)} now={now} disabled={waiting} onSave={addFact} />
                  )}
                </div>
              ))
            )}
            {stopped && failing.length === 0 && <p className="text-xs text-red-700 dark:text-red-400">The check stopped this draft without a reason on record.</p>}
            <button
              type="button"
              onClick={() => setShowChecks((all) => !all)}
              aria-expanded={showChecks}
              className="-my-2 inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-2 hover:underline md:my-0 md:min-h-0"
            >
              All checks
            </button>
          </div>
        )
      )}
      {factAdded && <FactAdded onUndo={() => void undoFact()} undoing={undoing} error={undoError} />}
      {showChecks && !dirty && (
        <ul className="space-y-2">
          {draft.audit.checks.map((check) => (
            <CheckLine key={check.id} check={check} />
          ))}
          {draft.claims.map((c, i) => (
            <li key={`claim-${i}`} className="text-xs text-muted-foreground">
              <span className={c.basis === "unverified" ? "text-red-700 dark:text-red-400" : undefined}>[{c.basis.replace("_", " ")}]</span> {c.text}
            </li>
          ))}
        </ul>
      )}

      {/* One primary button: Reply, then I posted it in the same place. */}
      {replied && canAct ? (
        <Actions
          stay
          primary={
            <button type="button" disabled={waiting} aria-busy={posting || undefined} onClick={onMarkPosted} className={MAIN}>
              {posting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />} I posted it
            </button>
          }
        >
          <button type="button" disabled={waiting} aria-busy={replying || undefined} onClick={() => void reply(stopped)} className={CHIP}>
            <BusyLabel busy={replying}>Open {surface === "web" ? "it" : surfaceLabel(surface)} again</BusyLabel>
          </button>
          <button type="button" onClick={() => onRepliedChange(false)} className={CHIP}>
            Not posted
          </button>
        </Actions>
      ) : (
        <Actions
          stay
          primary={
            postable ? (
              <button type="button" disabled={waiting} aria-busy={postingX || undefined} onClick={() => void postX()} className={MAIN}>
                {postingX ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}{" "}
                {postingX ? "Posting…" : "Post on X"}
              </button>
            ) : (
            <button type="button" disabled={waiting} aria-busy={replying || undefined} onClick={() => void reply(stopped)} className={MAIN}>
              {replying ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Reply className="h-4 w-4" aria-hidden="true" />
              )}{" "}
              {copied ? "Copied, opening…" : stopped ? "Reply anyway" : replyLabel(surface)}
            </button>
            )
          }
          menu={fullMenu}
        >
          <>
            {dirty && (
              <button type="button" disabled={waiting} aria-busy={saving || undefined} onClick={() => void save()} className={CHIP}>
                <BusyLabel busy={saving}>Check again</BusyLabel>
              </button>
            )}
            {onCorrect &&
              FIX_PRESETS.slice(0, 2).map((preset) => (
                <button key={preset} type="button" disabled={waiting} aria-busy={asked === preset || undefined} onClick={() => void submitFix(preset)} className={CHIP}>
                  <BusyLabel busy={asked === preset}>{preset}</BusyLabel>
                </button>
              ))}
            {onCorrect && (
              <button type="button" disabled={rewriting} onClick={() => dispatchFix({ type: "toggle" })} aria-expanded={fix.open} className={CHIP}>
                <BusyLabel busy={rewriting && asked !== null && !FIX_PRESETS.slice(0, 2).some((preset) => preset === asked)}>Fix…</BusyLabel>
              </button>
            )}
            {onSkip && (
              <SkipChip busy={waiting} skipping={skipping} onSkip={onSkip} />
            )}
          </>
        </Actions>
      )}

      {rewriting && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Rewriting…
        </p>
      )}
      {fix.open && !rewriting && (
        <form
          noValidate
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitFix(fix.reason);
          }}
        >
          <textarea
            value={fix.reason}
            onChange={(e) => dispatchFix({ type: "type", reason: e.target.value })}
            rows={2}
            maxLength={REASON_MAX}
            placeholder={FIX_PLACEHOLDER}
            aria-label="What is wrong with the draft"
            aria-invalid={fix.error ? true : undefined}
            className={cn(FIELD, "py-2 leading-relaxed")}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="submit" disabled={busy} className={cn(CHIP, "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary")}>
              Fix
            </button>
            <button type="button" onClick={() => dispatchFix({ type: "preset", preset: FIX_PRESETS[2] })} className={CHIP}>
              {FIX_PRESETS[2]}
            </button>
            <button type="button" onClick={() => dispatchFix({ type: "toggle" })} className={CHIP}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {fix.error && (
        <Problem>
          {fix.error.text}
          {errorHref && (
            <>
              {" "}
              <Link href={errorHref} className="font-medium underline underline-offset-2">
                {fixLinkLabel(errorHref)}
              </Link>
            </>
          )}
        </Problem>
      )}
      {fix.kept && !fix.open && !rewriting && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span role="status">{fix.kept.blocked ? "Rewritten, and a check still fails." : "Rewritten."}</span>
          {fix.promoted?.ok ? (
            <span role="status">{fix.promoted.text}</span>
          ) : (
            <button type="button" disabled={fix.promoting} aria-busy={fix.promoting || undefined} onClick={() => void addToNotes()} className={CHIP}>
              <BusyLabel busy={fix.promoting}>Remember this note</BusyLabel>
            </button>
          )}
          {fix.promoted && !fix.promoted.ok && <Problem>{fix.promoted.text}</Problem>}
        </div>
      )}
      {postable && !replied && !xNote && (
        <p className="text-xs text-muted-foreground">Posts this reply from @{xPostingUsername} now. Nothing else is posted.</p>
      )}
      {xNote && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {xNote.text}
          {xNote.url && (
            <>
              {" "}
              <a href={xNote.url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
                Open X with your reply
              </a>
            </>
          )}
        </p>
      )}
      {saveError && <Problem>{saveError}</Problem>}
    </div>
  );
}

/**
 * "Write my own", on an item with no draft: the reply box, and Reply under
 * it. The tap stores the text first as the person's own draft, checked by
 * the same gate, then opens it the way an edited draft is opened
 * (`replyThenOpen`), so "I posted it" records which text went out.
 */
export function OwnReply({
  target,
  onSave,
  onReplied,
  onCancel,
}: {
  target: Pick<PlacementTargetRecord, "surface" | "url">;
  onSave: (body: string) => Promise<SaveDraftResult>;
  onReplied?: () => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const text = body.trim();
  const intentFor = (value: string) => (target.surface === "x" ? xReplyIntentUrl(target.url, value) : null);

  const reply = async () => {
    if (replying || !text) return;
    setReplying(true);
    setSaveError(null);
    const reserved = reserveTab();
    try {
      const outcome = await replyThenOpen({
        dirty: true,
        blocked: false,
        anyway: false,
        body,
        save: async () => {
          const result = await onSave(body);
          if (!result.ok) {
            setSaveError(result.error);
            return null;
          }
          return result.draft;
        },
        urlFor: (value) => intentFor(value) ?? target.url,
        copy: (value) => copyText(value),
        open: (url) => openIn(reserved, url),
        then: onReplied,
      });
      if (outcome !== "opened") reserved?.close();
    } finally {
      setReplying(false);
    }
  };

  return (
    <div className="space-y-3">
      <GrowingText
        value={body}
        onChange={setBody}
        label="Your reply"
        placeholder="Write it in your own words."
        className="min-h-[4.5rem] rounded-lg border border-foreground/15 bg-background px-3 py-2 text-[17px]"
      />
      <Actions
        primary={
          <button type="button" disabled={!text || replying} onClick={() => void reply()} className={MAIN}>
            {replying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Reply className="h-4 w-4" aria-hidden="true" />}{" "}
            {replyLabel(target.surface)}
          </button>
        }
      >
        {onCancel && (
          <button type="button" onClick={onCancel} className={CHIP}>
            Cancel
          </button>
        )}
      </Actions>
      {saveError && <Problem>{saveError}</Problem>}
    </div>
  );
}

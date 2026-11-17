import { llmFailureKind } from "@/lib/providers/llm/types";

/** How long the open page keeps asking before it tells the person to refresh. */
export const DRAFT_WAIT_MS = 6 * 60_000;

/** Between asks. A running job is left alone; a waiting one is continued. */
export const DRAFT_POLL_MS = 2_000;

/**
 * What the card says while a draft is written and when it is done. The card
 * is the one place: the top of the page does not repeat it.
 */
export function draftWaitMessage(): string {
  return "Writing your reply…";
}

export function draftStillWaitingMessage(): string {
  return "Still writing, almost there.";
}

export function draftGaveUpWaitingMessage(): string {
  return "Still writing in the background. Refresh in a minute; if it stopped, the reason will be on this card.";
}

const VARIANT_NAME: Record<string, string> = {
  short_comment: "The reply",
  detailed_answer: "The long reply",
  article_draft: "The post",
  github_issue: "The issue comment",
  github_pr_proposal: "The list entry",
};

/**
 * What the card says once the job has finished. Only a variant that passed
 * is saved, and one that did not is named, because it is missing from the
 * card. `writes` is accepted for the route's payload and not repeated: how
 * many tries it took is the system's business.
 */
export function draftFinishedMessage(
  status: string | null | undefined,
  _writes?: number | null,
  omitted?: string[] | null
): string {
  const leftOut = (omitted ?? []).filter(Boolean);
  const missing = leftOut.length
    ? ` ${leftOut.map((variant) => VARIANT_NAME[variant] ?? variant).join(" and ")} didn't pass the check, so ${leftOut.length === 1 ? "it wasn't saved" : "they weren't saved"}.`
    : "";
  if (status === "needs_review") return `Ready, but a check needs a look.${missing}`;
  return `Ready.${missing}`;
}

/**
 * How every decline a draft job can still make begins. The card reads it to
 * offer the person's way out (Write it anyway, Open, Reject); the job writes
 * it through `declinedMessage`, never by hand.
 */
export const DECLINED_PREFIX = "Not drafted: ";

const DECLINE_ACTIONS = "Your call: write it anyway, open it, or reject it.";

/**
 * A decline in plain words: why nothing was written, then what the person can
 * do. `why` is the true reason (the model's own, or the rule's), never a
 * stock sentence that names a different one.
 */
export function declinedMessage(why: string): string {
  const reason = why.trim().replace(/[.\s]+$/, "");
  return `${DECLINED_PREFIX}${reason}. ${DECLINE_ACTIONS}`;
}

/** The model judged the thread, in its own words, as not worth a reply. */
export function declinedByModelMessage(reason: string | null | undefined): string {
  const said = (reason ?? "").trim().replace(/[.\s]+$/, "");
  if (!said) return declinedMessage("the AI found nothing worth saying in this thread");
  const quoted = said.length > 200 ? `${said.slice(0, 199).trimEnd()}…` : said;
  return declinedMessage(`the AI found nothing worth saying in this thread ("${quoted}")`);
}

export function isDeclinedMessage(message: string | null | undefined): boolean {
  return (message ?? "").startsWith(DECLINED_PREFIX);
}

/** The provider's account cannot pay. Generation is paused; the thread is not judged. */
export const DRAFT_PAUSED_BILLING =
  "Drafting is paused: the AI provider's credits ran out. Top up and press Generate draft again.";

/** The provider did not answer, or is not set up. Again, no verdict on the thread. */
export const DRAFT_PAUSED_UNAVAILABLE =
  "Drafting is paused: the AI provider is not answering right now. Press Generate draft again in a few minutes.";

export type DraftFailureKind = "declined" | "paused" | "failed";

/**
 * What the card says when a draft job ended without a draft. The job's own
 * sentence stays in `jobs.last_error` for diagnosis; the card reads it here.
 * A billing or provider failure becomes one line saying drafting is paused,
 * with no vendor's wording and nothing that reads as a verdict on the thread
 * (two runs on 8 November 2026 showed "Gemini credits are depleted … The
 * fallback failed too: Claude … credit balance is too low" on the card). A
 * decline keeps its reason and is marked so the card offers the actions.
 */
export function draftFailureForCard(raw: string | null | undefined): { kind: DraftFailureKind; text: string } {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "failed", text: "Drafting failed. Press Generate draft again." };
  if (isDeclinedMessage(text)) return { kind: "declined", text };
  const llm = llmFailureKind(text);
  if (llm === "billing") return { kind: "paused", text: DRAFT_PAUSED_BILLING };
  if (llm === "unavailable") return { kind: "paused", text: DRAFT_PAUSED_UNAVAILABLE };
  return { kind: "failed", text };
}

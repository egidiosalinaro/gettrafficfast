import { domainOf } from "@/lib/providers/serp/types";
import { isCompanySource } from "@/lib/domain/source-matching";
import { noteRules } from "@/lib/voice/settings";
import { correctionProblems } from "./correction-check";
import type { RecentFacts } from "@/lib/voice/fact-rules";
import type { FactConfirmations } from "@/lib/voice/staleness";
import { factProblems } from "./fact-fit";
import { repeatedFacts } from "./fact-repeats";
import { unrecordedEvents } from "./first-hand-events";
import { undeclaredNumberSentences } from "./numeric-claims";
import { variantCarriesLink, variantNamesBusiness } from "./link";
import { contentTokens, overlap } from "./rules";
import type { DraftImages } from "./media";
import type { PostReading } from "./reading";
import type { PlacementVariant } from "./workflow";

/**
 * The gate. A draft is refused when it would be spam, when it does not answer
 * the person, when it makes claims nobody can check, when it only works as
 * an advert, when a reply names the business or links to it at all, or when
 * it is written the way a marketer writes and a participant does not. A
 * reply is the answer and nothing else; only the list entry and the article
 * name the project (lib/placements/link.ts). Deterministic on
 * purpose: the same text always gets the same verdict, every check names
 * itself, and a reviewer who edits the body sees exactly which line flipped.
 *
 * Detectors may use patterns; nothing here rewrites the text. The result is a
 * checklist the inbox shows beside the draft, with the failing items first.
 */

export type { PlacementVariant } from "./workflow";

export const CLAIM_BASES = ["business_profile", "thread", "general_knowledge", "unverified"] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];

export interface DraftClaim {
  text: string;
  basis: ClaimBasis;
}

export interface DraftForAudit {
  variant: PlacementVariant;
  body: string;
  linkUrl: string | null;
  claims: DraftClaim[];
}

export interface AuditContext {
  thread: { surface: string; kind: string; title: string; excerpt: string | null };
  business: { name: string; domains: string[]; brandNames: string[] };
  angle: string | null;
  expertise: string[];
  /**
   * What is recorded as true about the writer (Settings → Voice). Empty or
   * absent means nothing is, and then a draft that says "I've seen" or "for
   * us" is claiming an experience nobody recorded. `instructions` are the
   * writer's own notes; the `follows_your_notes` check reads them.
   * `confirmedFacts` ("Still true", lib/voice/staleness.ts) only decides
   * which dated facts are stale; nothing else reads it.
   */
  writer?: { aboutYou: string; instructions?: string; confirmedFacts?: FactConfirmations };
  /**
   * The clock, for one question only: is a dated fact from About you, older
   * than `STALE_AFTER_DAYS` (lib/voice/staleness.ts), stated with no word of
   * when? Absent, that question is not asked, and the same text gets the
   * same verdict whatever the day.
   */
  now?: Date;
  /**
   * Set only when the text is a rewrite made from the owner's note ("Fix
   * it"): the note. The gate then asks whether the rewrite follows it or
   * answers it (`follows_your_correction`, lib/placements/correction-check.ts).
   * Absent, that check is not part of the audit.
   */
  correction?: string;
  /**
   * Which About you sentences the business's recent replies used
   * (lib/placements/recent-facts.ts). Set by the drafting job and the "Fix
   * it" rewrite; the advisory check "Repeats a recent fact" is then part of
   * the audit. Absent (a person's own edit or reply), it is not.
   */
  recentFacts?: RecentFacts;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface AuditCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /**
   * True for a check in `ADVISORY_CHECKS`: a note for the reviewer, never a
   * warning, and never part of "All checks passed". Set on every check the
   * gate writes; an audit stored before the flag existed has none, so read
   * it through `isAdvisory`.
   */
  advisory?: boolean;
  /**
   * On a failed `verifiable_claims` only: the sentences of the text the
   * person can confirm as true, one tap each ("It's true: add to About
   * you", lib/voice/about-you.ts). The numbers nobody declared, and the
   * experience claimed with nothing recorded. Absent when there are none,
   * and on an audit stored before 12 November 2026.
   */
  confirmable?: string[];
}

export interface AuditResult {
  status: "passed" | "warning" | "blocked";
  checks: AuditCheck[];
  /**
   * How the drafter read the post before writing (lib/placements/reading.ts):
   * its tone and what the poster means. Kept beside the verdict, not part
   * of it: the gate never sets it and no check reads it. Absent on an audit
   * stored before 10 November 2026, on a person's own reply, and when the
   * model gave none.
   */
  reading?: PostReading;
  /**
   * What the drafter saw of the post's images (lib/placements/media.ts,
   * `withImages`): how many the post has, how many the model was handed,
   * and why not the rest. Absent when the post has none or nobody asked.
   */
  images?: DraftImages;
}

/** The audit with the drafter's reading of the post beside it; unchanged when there is none. */
export function withReading(audit: AuditResult, reading: PostReading | null | undefined): AuditResult {
  return reading ? { ...audit, reading } : audit;
}

/**
 * Checks the reviewer reads but the verdict ignores: their warning never
 * turns a pass into "warning", and the draft loop never asks a rewrite to
 * fix them. `business_coherence` is one: a reply names no product and speaks
 * from the writer, so a reply outside the business's keywords is not a
 * defect. Counted toward the status, its warning kept every off-topic reply
 * out of the inbox (only a pass is saved) and told each rewrite to steer
 * toward the business's keywords; a post the owner chose by hand on 8
 * November 2026, about turning sketches into watercolors with AI, is the case.
 */
export const ADVISORY_CHECKS: ReadonlySet<string> = new Set(["business_coherence", "image_not_read", "repeats_recent_fact"]);

/**
 * The advisory check "Repeats a recent fact" (lib/placements/fact-repeats.ts):
 * the draft uses an About you sentence already in 2 or more of the last 10
 * replies. Advisory, because the fact is true and allowed, so it never
 * blocks a draft or changes the verdict, a short reply included; but it is
 * one of `REWRITE_ONCE_CHECKS`.
 */
export const REPEATS_RECENT_FACT = "repeats_recent_fact";

/**
 * Advisory checks the draft loop still asks one rewrite to fix, and only
 * one: on 12 November 2026 5 of the last 17 drafts said "position 30-40",
 * and naming the fact to the rewrite is what makes the next text say
 * something else. More than one write spent on a true fact would buy
 * little and push the model toward reaching for any other fact; the best
 * write is kept with the note showing.
 */
export const REWRITE_ONCE_CHECKS: ReadonlySet<string> = new Set([REPEATS_RECENT_FACT]);

/** An advisory check the first rewrite is asked to fix. */
export function asksForOneRewrite(check: Pick<AuditCheck, "id" | "status">): boolean {
  return check.status !== "pass" && REWRITE_ONCE_CHECKS.has(check.id);
}

/**
 * The advisory check "Image not read" (lib/placements/media.ts): the post
 * has an image the drafter could not see. Advisory, because the text is not
 * at fault and no rewrite can fix it; a person has to look at the picture.
 */
export const IMAGE_NOT_READ = "image_not_read";

/**
 * Checks that ask the rewrite to fix them but never change the verdict: the
 * writer's own style rules (`follows_your_notes`). A reply in sentence case
 * when the notes ask for lowercase is still the right reply, so it is
 * written again with the note named, and if every write still has capitals
 * the best one is saved with the warning showing, not thrown away the way a
 * counted warning would be (only a pass is saved). The reviewer sees it as
 * a warning, unlike an advisory note.
 */
export const STYLE_CHECKS: ReadonlySet<string> = new Set(["follows_your_notes"]);

/** An advisory check: by its flag, or by its id for an audit stored before the flag. */
export function isAdvisory(check: Pick<AuditCheck, "id" | "advisory">): boolean {
  return check.advisory ?? ADVISORY_CHECKS.has(check.id);
}

/** A check the verdict counts: neither advisory nor a style rule. */
export function countsTowardVerdict(check: AuditCheck): boolean {
  return !ADVISORY_CHECKS.has(check.id) && !STYLE_CHECKS.has(check.id);
}

/** A check the draft loop hands to the rewrite: not passed, and not advisory. */
export function asksForRewrite(check: AuditCheck): boolean {
  return check.status !== "pass" && !isAdvisory(check);
}

const URL_PATTERN = /https?:\/\/[^\s)>\]]+/gi;
const hasUrl = (text: string) => /https?:\/\/[^\s)>\]]+/i.test(text);

// "Try X" and "Use X" open half of all good advice ("Use question-shaped
// headings"), and a reply now names no product, so a bare imperative is not
// a pitch. Aimed at the brand by name it is: brandPitchPattern below.
const PITCH_OPENERS =
  /^((check out|try|use) (my|our)\b|i('m| am) the (founder|creator|maker|ceo)|we (built|made|created|offer)|our (tool|product|platform|app)|shameless plug|full disclosure|disclaimer: i)/i;

const SPAM_PHRASES =
  /\b(dm me|click here|limited (time )?offer|sign up now|act now|buy now|100% free|no credit card|guaranteed results|best in the (world|market)|#1 (tool|platform|solution)|link in bio)\b/i;

// The superlative as a claim ("X is the best tool"), not as advice ("pick
// the best tool for each job"), which a person says all the time.
const UNVERIFIABLE =
  /\b(guaranteed|proven to|scientifically proven|studies show|research shows|experts agree|everyone knows|always works|never fails|(is|are|was|remains|ranks as|makes it|it's) the best (tool|platform|solution|way|option|choice)\b)/i;


/**
 * What a participant does not write and a pitch always does. Any one of
 * these is the sales close, however soft, so any one blocks.
 */
const PITCH_PHRASES =
  /\b(you might want to (check out|look into|try|give)|(well )?worth (checking out|looking into|a look|a try|trying)|definitely worth|i('d| would) (highly |strongly |definitely )?recommend|highly recommend|learn more (about|at|here)|look no further|take a look at|be sure to (check|try)|don't hesitate to|feel free to (check|reach|try))\b/i;

/**
 * The maker speaking. The reply is written as someone who uses the product,
 * and the owner's rule is absolute: never as someone who builds it. The
 * brand-bound forms are built per business below; these stand on their own.
 */
// Only forms a user never has a reason to write. "my team", "we built our
// calendar around it" are things a user says about their own shop, so the
// maker-by-name forms below carry the brand instead.
const MAKER_PHRASES =
  /\b((i|we)('m| am|'re| are)? (the )?(founder|co-?founder|creator|maker|developer|builder|ceo|cto) (of|behind)|which is why (i|we) care|(our|my) (product|platform|startup|users|customers)|full disclosure|disclaimer|shameless plug)\b/i;

/** "I work on <brand>", "we built <brand>", "I'm behind <brand>": the maker, by name. */
function makerByNamePattern(names: string[]): RegExp | null {
  const parts = names.map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length
    ? new RegExp(
        `\\b((i|we) (work on|built|build|made|make|created|create|founded|develop|developed|maintain|designed|design|ship|shipped|launched|run)|(i'm|i am|we're|we are) (the (people|team|ones?) )?behind)\\s+(the\\s+)?\\[?(${parts.join("|")})`,
        "iu"
      )
    : null;
}

/**
 * First-person experience: fine when the business recorded what is true about
 * the writer, an invention when it did not. High-precision on purpose: an
 * opinion ("I think", "for me the key is") is not an experience claim.
 */
const EXPERIENCE_CLAIMS =
  /\b((i|we)('ve| have) (been using|used|seen|found|noticed|tried|tested|run|built|worked|had)|in (my|our) experience|(i|we) (use|run|switched to|moved to|ended up (using|with)|tried|tested|built)|(worked|works) for us|for us\b)/i;

/**
 * The tells of a text written to promote rather than to answer: the pivot,
 * the benefits vocabulary, the brochure words. One is a warning the reviewer
 * sees; two block (three in an article, which has room for a stray one).
 *
 * The second family is the essay register, added from the drafts of 29
 * September that passed every check and still read as written by a model:
 * a framing opener ("it's easy to get caught up in"), the pivot to "where
 * the real bottleneck lies", the impact line, and a last sentence that sums
 * up or tells the reader how to think ("Considering the path from idea to
 * post can change how you weigh a tool"). Each match is reported with the
 * words that tripped it, so a rewrite knows what to cut.
 */
const AI_TELLS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bgame[- ]chang(er|ers|ing)\b/i, name: "game-changer" },
  { pattern: /\brevolutioni[sz](e|es|ed|ing)\b/i, name: "revolutionize" },
  { pattern: /\bseamless(ly)?\b/i, name: "seamless" },
  { pattern: /\bunlock(s|ed|ing)?\b/i, name: "unlock" },
  { pattern: /\bempower(s|ed|ing|ment)?\b/i, name: "empower" },
  { pattern: /\bleverag(e|es|ed|ing)\b/i, name: "leverage" },
  { pattern: /\bstreamlin(e|es|ed|ing)\b/i, name: "streamline" },
  { pattern: /\btransform(s|ed|ing|ative)?\b/i, name: "transform" },
  { pattern: /\brobust\b/i, name: "robust" },
  { pattern: /\bcutting[- ]edge\b/i, name: "cutting-edge" },
  { pattern: /\b(hands[- ]off|set[- ]it[- ]and[- ]forget[- ]it|self[- ]optimi[sz]ing)\b/i, name: "hands-off" },
  {
    pattern:
      /\bthe real (power|magic|value|benefit|gains?|win|difference|advantage|time[- ]saver|game[- ]changer|bottleneck|friction|challenge|impact|efficiency|problem|issue|test|question|trick|key|secret|lever|leverage|driver|work|payoff|opportunity|time[- ]sink|cost|savings?) (often |usually |really |actually )?(comes? from|is|lies?( in)?|of|happens|shows up|hides?)\b|\b(is|are|'s) (often|usually|typically) where the (real|actual|true|biggest|most) [a-z-]+( lies| is| comes from| happens| sits)?\b/i,
    name: "the real power",
  },
  // The X reply of 9 November 2026 ("It's tough to tell if these tools
  // work… Finding them is one thing, but are they actively looking for a
  // solution? That's the real test.") passed the gate, and the owner read it
  // at once as a model's: the hedge before the answer, the one-thing pivot,
  // the verdict after a rhetorical question. Each is a tell of its own.
  {
    // "That's the real test." as a verdict, with nothing after it. With a
    // verb after it ("the real test is") it is "the real power" above.
    pattern:
      /\b(that|this|it|which)('s| is| was) (the|your) real (test|question|problem|challenge|key|issue|win|trick|point|story|lesson|answer|difference|secret|work)\b(?! (often |usually |really |actually )?(comes? from|is|lies?|of|happens|shows up|hides?)\b)/i,
    name: "that's the real test",
  },
  {
    // "X is one thing, but Y", "X is one thing; Y is another", "it's one
    // thing to X, it's another to Y". "There's one thing" is not it.
    pattern:
      /(?<!\bthere ?)(\b(is|are|was|were) |'s )one thing(\s*[,;:—–-]\s*(but|yet)\b|\s*[,;:.—–-]\s*[^.!?]{0,80}?\b(is|are|'s) (another|a different (thing|story|matter|game)|something else)\b| to [^.!?]{1,80}?\b(another|something else)\b)/i,
    name: "X is one thing, but Y",
  },
  {
    pattern: /\bit('s| is) ((really|pretty|often|always|still|kinda|super) )?(tough|hard|difficult|tricky) to (tell|say|know|judge) (if|whether)\b/i,
    name: "it's hard to tell if",
  },
  { pattern: /\bhere('s| is) the thing\s*([:,.;—–-]|$)/im, name: "here's the thing" },
  {
    // Not "the key is stored in the env": a GitHub comment has keys in it.
    pattern:
      /\bthe key (thing |point |takeaway |part |here |really )?is\b(?!\s+(stored|kept|saved|missing|wrong|invalid|expired|set|read|passed|sent|generated|rotated|revoked|valid|correct|in|on|under|at|from)\b)/i,
    name: "the key is",
  },
  { pattern: /\b(when|if) (you('re| are) )?looking for\b/i, name: "when looking for" },
  {
    pattern: /\bit('s| is) (easy|tempting|common) to (see|think|assume|get caught up|overlook|forget|get lost|fall into|focus (too much|only|solely|purely))\b/i,
    name: "the framing opener",
  },
  {
    pattern:
      /\b(is|are) (great|solid|fine|good|excellent|powerful|useful|strong|decent)( choices?| picks?| options?| tools?)? (for|at) [^.!?]{1,80}[,.;] ?(but|however|though|yet)\b/i,
    name: "the setup-and-pivot",
  },
  {
    pattern:
      /\bmakes? (a|all the|the) (significant|huge|big|real|massive|noticeable|meaningful|major|world of) (impact|difference)\b|\bsignificant (impact|difference|gains?|improvements?|boost|reduction|advantage|help|time|amount)\b|\bsignificantly (reduc(e|es|ing)|improv(e|es|ing)|increas(e|es|ing)|boost(s|ing)?|cut(s|ting)?|lower(s|ing)?|faster|better|more|less|easier)\b/i,
    name: "the impact line",
  },
  { pattern: /\b(crucial|vital|pivotal|paramount|indispensable)\b/i, name: "crucial" },
  { pattern: /\btruly\b|\bgenuinely (effective|useful|valuable|powerful|helpful|impactful|transformative|matters?|drives?|helps?)\b/i, name: "genuinely" },
  // The imperative, at the start of a sentence or after "So," / "Beyond X,".
  { pattern: /(^|[.!?:,;]\s+)consider(ing)?\b/im, name: "consider…" },
  { pattern: /\bbefore (diving|jumping|getting|we get|you get) into\b/i, name: "before diving into" },
  {
    pattern:
      /\b(this|that|here)('s| is) where [^.!?]{1,50}? (comes? in|comes? into play|happens?|pays? off|breaks? down|hits? a wall|shines?|kicks in|gets? interesting|adds? up|matters? most|(really |genuinely |actually )?sav(e|es) (you )?time)\b/i,
    name: "this is where X comes in",
  },
  {
    pattern:
      /\bfrom ((a|an|the|your|content|keyword) )?[a-z' -]{2,30}? to (live|published|publish(ed|ing)?|launch|final publication|(a )?published post|going live|post(ing)? live|getting [a-z ]{1,20} live)\b/i,
    name: "from idea to live",
  },
  {
    pattern:
      /\b(heavy lifting|bogged down|wrestling with|the (mechanics|logistics) of|pays? dividends|piece of the puzzle|the last mile|hits? a wall|the (secret|magic) sauce|low[- ]hanging fruit|the elephant in the room|double[- ]edged sword|silver bullet|golden (nuggets?|rule)|pain points?)\b/i,
    name: "the cliché",
  },
  { pattern: /(^|[.!?]\s+)(it )?sounds like you('re| are)?\b|\bgreat question\b/i, name: "sounds like you" },
  { pattern: /\bit('s| is) worth (noting|mentioning|pointing out|remembering|considering)\b/i, name: "it's worth noting" },
  {
    // "at the end of the day" sums up wherever it sits, not only first.
    pattern: /(^|[.!?]\s+)(ultimately|overall|in short|in summary|in the end|all in all|bottom line|to sum up|in conclusion|the takeaway|the bottom line)\b|\bat the end of the day\b/i,
    name: "the summing-up",
  },
  { pattern: /\b(a|another) (different|more comprehensive|smarter|better|new|fresh|alternative|holistic) approach\b/i, name: "a different approach" },
  { pattern: /\binstead of just\b/i, name: "instead of just" },
  { pattern: /\b(beyond|more than) just\b/i, name: "beyond just" },
  { pattern: /\b(imagine|picture|think about) (a|an|something that|having|it\b) ?/i, name: "imagine a system" },
  // The pivot survives a full stop: "This isn't just about X. It's about Y"
  // is the same sentence with a period where the comma was, and it is what
  // a model writes once the comma form is named.
  {
    pattern: /\b(it|this|that)(?:'s| is)(?: not|n't) (?:just|only|merely|simply) [^.!?]{1,60}[.,;:] (?:it|this|that)(?:'s| is)\b/i,
    name: "it's not just X, it's Y",
  },
  { pattern: /\b(less|not so much) about [^.!?]{1,80} (and|but) more about\b/i, name: "less about X, more about Y" },
  { pattern: /\b(isn't|is not|aren't|are not|not) (just|only|merely) [^.!?]{1,60}, but\b/i, name: "not just X, but Y" },
  { pattern: /\b(a step beyond|goes beyond|moving beyond) [^.!?;]{1,60}[;,] (it|this|that)('s| is)\b/i, name: "a step beyond X; it's Y" },
  { pattern: /\b(in today's|in the ever[- ]evolving|in the (digital |modern )?landscape)\b/i, name: "in today's landscape" },
  { pattern: /\bstrong contenders?\b/i, name: "strong contender" },
  { pattern: /\bend[- ]to[- ]end (automation|solution|platform|agent|system|workflow)\b/i, name: "end-to-end solution" },
  {
    pattern: /\b(without (any |constant |much )?manual (effort|input|work|intervention)|eliminat(e|es|ing) the need for|sav(e|es|ing) you (hours|time)|minimi[sz](e|es|ing) manual|frees? (you )?up|on autopilot)\b/i,
    name: "the benefits line",
  },
  {
    pattern: /\b(a|an) (system|tool|agent|platform|service|solution|setup) that (handles|automates|does|takes care of|manages|runs|acts as|can handle)\b/i,
    name: "describes an unnamed tool",
  },
  {
    pattern: /\b(new|newer|emerging|different|whole new) (category|class|breed|generation|wave|kind) of (ai )?(agents?|tools?|platforms?|services?|solutions?|software)\b/i,
    name: "the new category pitch",
  },
  {
    pattern: /\b(automat(e|es|ing)|handl(e|es|ing)|cover(s|ing)?|tak(e|es|ing) over|own(s|ing)?) the (entire|whole|full|complete|end[- ]to[- ]end) ([a-z-]+ ){0,2}(lifecycle|workflow|process|pipeline|stack|loop|cycle|journey)\b/i,
    name: "the whole workflow",
  },
  // What the product did for the writer, as the sentence after the mention:
  // "I manage my own site's blog publishing with X. It keeps the calendar
  // full." Narrow on purpose: a tell is deleted with its sentence.
  {
    pattern: /\b(it|that|which) (keeps|kept) (the|my|your|our) ((content|editorial|publishing|posting|blog) )?calendar (full|fed|filled|stocked|topped up)\b/i,
    name: "the benefit tail",
  },
];

/**
 * The "I use <product> for that" sentence. All 21 replies published between
 * 28 September and 8 October 2026 carried one ("GetTrafficFast
 * (https://gettrafficfa.st/) is what I use for that", "I manage my own
 * site's blog publishing with GetTrafficFast", "that's the part I have
 * GetTrafficFast doing"), and every one read as the same disguised advert.
 * Refused in every variant, the article included.
 *
 * Three layers, from the most certain to the most specific:
 *
 * - `CAMPAIGN_MENTION`: the pasted line that needs no name to be recognised,
 *   "I publish my own site's blog through".
 * - `NAMED_USE_MENTION`: "<Name> is what I use for that" and "the part I
 *   have <Name> doing" with any capitalised name ("the bit" is the same
 *   sentence as "the part": the model swaps one noun once the other is
 *   named), and the "I use / I let X handle / I run … with X" forms when
 *   the name carries a link, which is what makes it a plug and not "I use a
 *   spreadsheet for that". Case-sensitive, so a lowercase noun is never a
 *   name and "the part I have to keep doing" is not a mention.
 * - `ownUsePattern`: every form, bound to the business's own names, where
 *   there is no ambiguity left to avoid.
 */
export const CAMPAIGN_MENTION = /\bi publish(?:es|ed)? my own (?:site'?s? )?blog (?:through|with|via|using)\b/i;

/** A name as a reply writes it after the fact: its URL, or the "(...)" a person leaves in its place, in parentheses. */
const LINK_TAIL = String.raw`(?:\s*\((?:https?:\/\/[^)\s]*|\.{3}|…)\))?`;

/** Capitalised words that open an ordinary sentence and are never a product. */
const NOT_A_NAME =
  "This|That|These|Those|It|Which|What|Here|There|One|Mine|Nothing|Something|Everything|Anything|Each|Both|Either|Neither|The|A|An|My|Our|Your|Their|His|Her|Its|Nobody|Someone|Everyone";

/** A capitalised name, or a Markdown-linked one, optionally followed by its URL. */
const CAPITALISED_NAME = String.raw`(?:\[[^\]]+\]\([^)\s]*\)|\b(?!(?:${NOT_A_NAME})\b)[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3})${LINK_TAIL}`;

/** A name that carries a link: "[Name](https://…)" or "Name (https://…)". */
const LINKED_NAME = String.raw`(?:\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\b[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3}\s*\(https?:\/\/[^)\s]+\))`;

export const NAMED_USE_MENTION = new RegExp(
  [
    String.raw`${CAPITALISED_NAME}\s+(?:is|'s) what (?:I|[Ww]e) use for (?:that|this|it)\b`,
    String.raw`\b(?:[Tt]he part|[Tt]he bit|[Ww]hat) (?:I|[Ww]e) (?:have|let) ${CAPITALISED_NAME}\s+(?:do|doing|handle|handling|send|sending|run|running|write|writing|publish|publishing|post|posting)\b`,
    String.raw`\b(?:I|[Ww]e) (?:use|used|rely on)\s+${LINKED_NAME}`,
    String.raw`\b(?:I|[Ww]e) (?:have|let) ${LINKED_NAME}\s+(?:do|doing|handle|handling)\b`,
    String.raw`\b(?:I|[Ww]e) (?:handle|manage|run|publish)\b[^.!?]{0,100}?\b(?:with|through|via|using) ${LINKED_NAME}`,
  ].join("|")
);

function escapeNames(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/**
 * Every form of the use-mention, bound to the business's own names (plain,
 * Markdown-linked, or followed by the URL): "X is what I use", "I use X",
 * "I have X doing", "I run / manage / publish … with X", "the part I have
 * X doing". Null when the business has no name to look for.
 */
export function ownUsePattern(names: string[]): RegExp | null {
  const parts = escapeNames(names);
  if (parts.length === 0) return null;
  const name = String.raw`\[?(?:${parts.join("|")})(?![\p{L}\p{N}])(?:\]\([^)\s]*\))?${LINK_TAIL}`;
  return new RegExp(
    [
      String.raw`${name}\s+(?:is|'s|was) (?:what|the (?:tool|thing|one|app|service)) (?:i|we) (?:use|used|rely on|run|lean on)\b`,
      String.raw`\b(?:i|we)(?:'m| am|'re| are|'ve been| have been)? (?:use|used|using|rely on|relying on|lean on|went with|switched to|moved to|ended up (?:using|with))\s+(?:the\s+)?${name}`,
      String.raw`\b(?:i|we) (?:have|let|get|got|had) (?:the\s+)?${name}\s+(?:do|doing|does|handle|handling|handles|take care of|taking care of|run|running|publish|publishing|send|sending|write|writing|manage|managing)\b`,
      String.raw`\b(?:i|we) (?:handle|handled|manage|managed|run|ran|publish|published|do|did|schedule|automate|write|keep|post)\b[^.!?]{0,100}?\b(?:with|through|via|using|on|in) (?:the\s+)?${name}`,
      String.raw`\bthe (?:part|bit|piece|step) (?:i|we) (?:have|let|leave to|hand to|give to|use) ${name}`,
    ].join("|"),
    "iu"
  );
}

/** The words of the first "I use <product> for that" sentence in the text, or null. */
export function campaignMention(text: string, names: string[]): string | null {
  const own = ownUsePattern(names);
  return text.match(CAMPAIGN_MENTION)?.[0] ?? text.match(NAMED_USE_MENTION)?.[0] ?? (own ? (text.match(own)?.[0] ?? null) : null);
}

/**
 * True when a text is the advert shape a reply may no longer take: it names
 * the business, carries a URL, has the "I use X for that" line, or speaks as
 * the maker. The 21 replies posted between 28 September and 8 October 2026
 * all were; lib/placements/voice-examples.ts does not hand them to the
 * writer as a voice to copy.
 */
export function promotesBusiness(text: string, names: string[]): boolean {
  const body = straightQuotes(text);
  const maker = makerByNamePattern(names);
  return (
    hasUrl(body) ||
    countMatches(body, brandPattern(names)) > 0 ||
    campaignMention(body, names) !== null ||
    MAKER_PHRASES.test(body) ||
    (maker !== null && maker.test(body))
  );
}

/** How many statements about the product a reply may carry before it is a brochure. */
const PRODUCT_CLAIM_LIMIT = 3;

/**
 * The last sentence as the essay's conclusion: a summing-up adverb, a
 * gerund that tells the reader how to think ("Considering X can change how
 * you weigh Y", "Focusing on that helps ensure…"), or "that's where the real
 * gains are". A person stops on the last concrete thing they had to say.
 */
const ESSAY_CLOSER =
  /^((considering|thinking about|focusing on|prioriti[sz]ing|looking at|understanding|shifting|treating|framing|getting|knowing|having|building|investing|starting|nailing|fixing|automating|separating|choosing|picking|keeping|making|taking|putting|setting|planning) [^.!?]*\b(can|will|helps?|makes?|changes?|saves?|means|is what|goes a long way|pays off|leads? to)\b|(that|this|it)('s| is) (often |usually |typically )?(where the (real|biggest|actual|true|most)|what (truly|really|genuinely|actually) (drives?|makes?|matters?|counts?|moves?|separates?)|the kind of [^.!?]{1,60} that (pays?|makes?|drives?|keeps?))|(that|this) (kind|sort|type) of [^.!?]{1,60} is (what|where|why|how)\b)/i;

/** A sentence this long is written, not typed. */
const LONG_SENTENCE_WORDS = 40;

/**
 * The last sentence as a verdict on the question just asked: "…are they
 * actively looking for a solution? That's the real test." A rhetorical
 * question answered by the writer in five words is a model's cadence; a
 * person who asks lets the question stand, or says something concrete.
 */
const VERDICT = /^((and|so) )?(that|this)('s| is| was)\b/i;
const VERDICT_MAX_WORDS = 6;

function verdictAfterQuestion(all: string[]): string | null {
  if (all.length < 2) return null;
  const last = all[all.length - 1] ?? "";
  const before = all[all.length - 2] ?? "";
  return before.endsWith("?") && !last.endsWith("?") && words(last) <= VERDICT_MAX_WORDS && VERDICT.test(last) ? last : null;
}

/**
 * Typographic apostrophes as the plain one, so a tell typed on a phone
 * ("It’s tough to tell", "That’s the real test") is the same tell. One
 * character for one, so an index into the result is an index into the text.
 */
export function straightQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

interface Tell {
  name: string;
  /** The words that tripped it, so a rewrite knows what to cut. */
  sample: string | null;
}

/** Every AI tell the body carries, by name, each counted once, with what tripped it. */
function aiTells(text: string, variant: PlacementVariant): Tell[] {
  const body = straightQuotes(text);
  const found: Tell[] = [];
  for (const tell of AI_TELLS) {
    const match = body.match(tell.pattern);
    if (match) found.push({ name: tell.name, sample: match[0].replace(/^[.!?:\s]+/, "").trim() || null });
  }
  const all = sentences(body);
  const thisSentences = all.filter((s) => /^this\b/i.test(s)).length;
  if (thisSentences >= 3) found.push({ name: 'sentences that start with "This", three or more', sample: null });
  const emDashes = (body.match(/—/g) ?? []).length;
  if (emDashes >= (variant === "article_draft" ? 6 : 3)) found.push({ name: `${emDashes} em dashes`, sample: null });
  const last = all[all.length - 1] ?? "";
  if (all.length >= 3 && ESSAY_CLOSER.test(last)) found.push({ name: "the essay closer", sample: last });
  const verdict = verdictAfterQuestion(all);
  if (verdict) found.push({ name: "a verdict after a question", sample: verdict });
  let run = 0;
  for (const s of all) {
    run = s.endsWith("?") ? run + 1 : 0;
    if (run === 3) {
      found.push({ name: "a chain of questions", sample: null });
      break;
    }
  }
  const long = all.find((s) => words(s) >= LONG_SENTENCE_WORDS);
  if (long) found.push({ name: `a ${words(long)}-word sentence`, sample: long });
  return found;
}

/**
 * The tells a text carries, each as the checklist prints it, with the words
 * that tripped it. The draft job names them to a rewrite when it has
 * deleted the sentences they sat in (`withoutTells`), so the model is told
 * what it wrote and does not write it again.
 */
export function tellsIn(body: string, variant: PlacementVariant): string[] {
  return aiTells(body, variant).map(describeTell);
}

/**
 * The body with the sentences the voice check would refuse taken out.
 *
 * The model is told, and writes the same essay sentence again. These
 * sentences are exactly the ones the check names, so they are deleted here,
 * before the draft is judged: what remains is what can still pass, and a
 * reply that was only those sentences does not.
 */
export function withoutTells(body: string, variant: PlacementVariant): string {
  const raw = sentences(body);
  let cursor = 0;
  const spans = raw.map((text) => {
    const start = body.indexOf(text, cursor);
    const end = start + text.length;
    cursor = Math.max(cursor, end);
    return { text, start, end };
  });
  // A tell can sit across a full stop ("This isn't just about X. It's about Y"),
  // so a sentence is dropped when any part of it is inside a match. Matched
  // with plain apostrophes; the indices are the same in the text kept.
  const plain = straightQuotes(body);
  const condemned = new Set<number>();
  for (const tell of AI_TELLS) {
    const flags = tell.pattern.flags.includes("g") ? tell.pattern.flags : `${tell.pattern.flags}g`;
    const pattern = new RegExp(tell.pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(plain))) {
      const from = match.index;
      const to = from + match[0].length;
      spans.forEach((span, index) => {
        if (span.start < to && span.end > from) condemned.add(index);
      });
      if (match[0].length === 0) break;
    }
  }
  let parts = spans.filter((_, index) => !condemned.has(index)).map((span) => span.text);
  while (parts.filter((sentence) => /^this\b/i.test(sentence)).length >= 3) {
    let index = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^this\b/i.test(parts[i] ?? "")) {
        index = i;
        break;
      }
    }
    if (index < 0) break;
    parts.splice(index, 1);
  }
  if (parts.length >= 3 && ESSAY_CLOSER.test(straightQuotes(parts[parts.length - 1] ?? ""))) parts.pop();
  if (verdictAfterQuestion(parts.map(straightQuotes))) parts.pop();
  parts = parts.filter((sentence) => words(sentence) < LONG_SENTENCE_WORDS);
  const dashes = variant === "article_draft" ? 6 : 3;
  let text = parts.join(" ");
  while ((text.match(/—/g) ?? []).length >= dashes) {
    text = text.replace(/—/, ",");
  }
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

/** A tell as the checklist prints it: the name, then the words that tripped it. */
function describeTell(tell: Tell): string {
  if (!tell.sample) return tell.name;
  const sample = tell.sample.length > 70 ? `${tell.sample.slice(0, 67)}…` : tell.sample;
  return `${tell.name} ("${sample}")`;
}

/**
 * "check out GetTrafficFast", "try Get Traffic Fast": the sales close aimed at
 * the brand by name. Built from the business's own names, so a generic
 * "check out the CONTRIBUTING file" on GitHub is not mistaken for it.
 */
// The name may be a Markdown link, "[Name](url)": the bracket is not a
// disguise.
function brandPitchPattern(names: string[]): RegExp | null {
  const parts = names.map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length
    ? new RegExp(
        `\\b(check out|try|look into|have a look at|give|(services|tools|platforms|products|solutions|companies|options) (like|such as))\\s+(the\\s+|a\\s+)?\\[?(${parts.join("|")})`,
        "iu"
      )
    : null;
}

const LENGTH_LIMITS: Record<PlacementVariant, { minWords: number; maxChars: number }> = {
  // A person often writes less than a model would; the floor is what still
  // answers something, not what fills a paragraph.
  short_comment: { minWords: 15, maxChars: 1_200 },
  detailed_answer: { minWords: 60, maxChars: 6_000 },
  article_draft: { minWords: 300, maxChars: 20_000 },
  github_issue: { minWords: 40, maxChars: 6_000 },
  github_pr_proposal: { minWords: 20, maxChars: 4_000 },
};

/** X's limit for a reply, and what X counts a link as: every URL is wrapped to 23 characters. */
export const X_LIMIT = 280;
const X_URL_LENGTH = 23;

/** The length X measures: characters, with every link counted as 23 whatever its own length. */
export function xLength(text: string): number {
  return text.replace(URL_PATTERN, "x".repeat(X_URL_LENGTH)).length;
}

/**
 * A short X reply the model wrote a few characters over the limit. Words are
 * dropped from the end, the URL kept, until X's own count fits. The gate
 * then has nothing to fail on length.
 */
export function fitXLength(text: string, limit = X_LIMIT): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || xLength(words.join(" ")) <= limit) return words.join(" ");
  const url = words.map((word) => /https?:\/\//i.test(word));
  const keep = words.map(() => true);
  const droppable = words.map((_, index) => index).filter((index) => !url[index]);
  for (let n = droppable.length - 1; n >= 0 && xLength(words.filter((_, index) => keep[index]).join(" ")) > limit; n--) {
    keep[droppable[n]] = false;
  }
  return words
    .filter((_, index) => keep[index])
    .join(" ")
    .replace(/[,:;]\s*$/, "")
    .trim();
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(text: string): number {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? clean.split(" ").length : 0;
}

function brandPattern(names: string[]): RegExp | null {
  const parts = names.map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${parts.join("|")})([^\\p{L}\\p{N}]|$)`, "giu") : null;
}

function countMatches(text: string, pattern: RegExp | null): number {
  if (!pattern) return 0;
  return (text.match(pattern) ?? []).length;
}

/** The body with the link, and any sentence carrying it, removed. */
export function withoutLink(body: string, linkUrl: string | null): string {
  const kept = sentences(body).filter((s) => !hasUrl(s));
  const stripped = kept.length > 0 ? kept.join(" ") : body.replace(URL_PATTERN, "").trim();
  return linkUrl ? stripped.split(linkUrl).join("").trim() : stripped.trim();
}

/** How a sentence starts, as far as case goes; null when its first word says nothing about it. */
function sentenceStart(sentence: string): "upper" | "lower" | null {
  const start = sentence.replace(/^[^\p{L}\p{N}@#]+/u, "");
  // A number, a handle or a hashtag: no case to read.
  if (!start || /^[\p{N}@#]/u.test(start)) return null;
  const word = start.match(/^\p{L}[\p{L}\p{M}'.-]*/u)?.[0] ?? "";
  if (!word) return null;
  // The pronoun is capitalised by every phone keyboard; the owner's own
  // lowercase lines keep it ("I'm just thinking out loud").
  if (/^I('(m|ve|d|ll|s))?$/.test(word)) return null;
  // An acronym ("AI", "SEO") or a name with capitals inside it ("GitHub").
  if (word.length > 1 && (word === word.toUpperCase() || /\p{Lu}/u.test(word.slice(1)))) return null;
  return /^\p{Lu}/u.test(word) ? "upper" : /^\p{Ll}/u.test(word) ? "lower" : null;
}

/**
 * `follows_your_notes`: the writer's own notes, where code can read them.
 * Lowercase only for now, on a short reply: the X reply of 9 November 2026
 * came back in sentence case under notes that opened "Lowercase, short
 * lines, like a reply typed on a phone". A warning, written again by the
 * draft loop with the note named, and never the verdict (`STYLE_CHECKS`).
 */
function notesCheck(body: string, variant: PlacementVariant, instructions: string): AuditCheck {
  const check = (status: CheckStatus, detail: string): AuditCheck => ({
    id: "follows_your_notes",
    label: "Follows your own notes",
    status,
    detail,
  });
  if (!instructions.trim()) return check("pass", "No notes recorded in Settings → Voice.");
  if (!noteRules(instructions).lowercase) {
    return check("pass", "Nothing in your notes that this check reads yet (it reads lowercase, on a short reply).");
  }
  if (variant !== "short_comment") return check("pass", "Lowercase is checked on a short reply only.");
  const capitalised: string[] = [];
  let lowercase = 0;
  for (const sentence of sentences(body)) {
    const start = sentenceStart(sentence);
    if (start === "upper") capitalised.push(sentence);
    if (start === "lower") lowercase += 1;
  }
  if (capitalised.length === 0 || capitalised.length <= lowercase) {
    return check("pass", "Lowercase, as your notes ask.");
  }
  const quoted = capitalised
    .slice(0, 3)
    .map((sentence) => `"${sentence.split(/\s+/).slice(0, 3).join(" ")}…"`)
    .join(", ");
  return check(
    "warn",
    `Your notes ask for lowercase, and ${capitalised.length} of ${capitalised.length + lowercase} sentences start with a capital (${quoted}). Start every sentence lowercase, the way a reply typed on a phone does; names keep their capitals.`
  );
}

/**
 * The thread's words worth suggesting to a rewrite: the ones that carry its
 * subject. Words of manner and motion ("sometimes", "saying", "trying",
 * "calling") were suggested first because they came first in the post;
 * longer words, and nouns over verbs in -ing and adverbs in -ly, come first now.
 */
const FILLER_WORDS = new Set(["sometimes", "sometime", "saying", "trying", "calling", "really", "actually", "honestly", "something", "anything", "everything", "someone", "people", "things", "thing", "being", "doing", "going", "getting", "making", "seeing"]);
function suggestWords(source: Set<string>, used: Set<string>): string[] {
  return [...source]
    .filter((token) => !used.has(token) && !FILLER_WORDS.has(token))
    .sort((a, b) => Number(/(?:ing|ly)$/.test(a)) - Number(/(?:ing|ly)$/.test(b)) || b.length - a.length)
    .slice(0, 6);
}

export function auditDraft(draft: DraftForAudit, ctx: AuditContext): AuditResult {
  const checks: AuditCheck[] = [];
  // Typed on a phone, an apostrophe is "’": the same words, the same tells.
  const body = straightQuotes(draft.body.trim());
  const names = [ctx.business.name, ...ctx.business.brandNames];
  const brand = brandPattern(names);
  const urls = body.match(URL_PATTERN) ?? [];
  const allSentences = sentences(body);
  // A reply names nothing and links nothing; only the list entry and the
  // article name the project (lib/placements/link.ts).
  const naming = variantNamesBusiness(draft.variant);
  const businessName = ctx.business.name || "the business";

  // 1. Answers the person first: no pitch opener, and no name or link in the
  // first two sentences. A list entry is the line the list already uses, and
  // that line names the project: refusing it makes every awesome-list
  // proposal a blocked draft. In a reply a name or a link is refused
  // anywhere (checks 5 and 8); here it is named for where it sits.
  const listEntry = draft.variant === "github_pr_proposal";
  const opener = listEntry ? null : (body.match(PITCH_OPENERS)?.[0] ?? null);
  const firstSentences = allSentences.slice(0, 2).join(" ");
  const namedEarly = !listEntry && (countMatches(firstSentences, brand) > 0 || hasUrl(firstSentences));
  checks.push({
    id: "answers_first",
    label: "Answers the question before anything else",
    status: opener || namedEarly ? "fail" : "pass",
    detail: opener
      ? `The opening is a pitch ("${opener}"). The first sentence must answer the person.`
      : namedEarly
        ? "The opening names the business or a link. The first sentences must answer the person."
        : "The opening addresses the question, not the business.",
  });

  // 2. Still useful with the link deleted. A reply carries no link (check 8
  // refuses one), so with no URL in the text there is nothing to delete and
  // length is the platform check's job. Where there is a link, the sentence
  // that carries it is the mention, and the rest has to be the answer: at
  // least the variant's floor of words, and most of the text. A list entry
  // is its line and a two-sentence description, the line half the words by
  // construction, so in three sentences or fewer "most" is a lower bar.
  const bodyWords = words(body);
  const linked = urls.length > 0;
  const remainingWords = linked ? words(withoutLink(body, draft.linkUrl)) : bodyWords;
  const minWords = LENGTH_LIMITS[draft.variant].minWords;
  const shareRequired = allSentences.length <= 3 ? 0.4 : 0.6;
  const usefulWithoutLink = !linked || (remainingWords >= Math.min(minWords, 25) && remainingWords >= bodyWords * shareRequired);
  checks.push({
    id: "useful_without_link",
    label: "Still useful with the link deleted",
    status: usefulWithoutLink ? "pass" : "fail",
    detail: !linked
      ? "No link to delete: the text is the answer."
      : usefulWithoutLink
        ? `${remainingWords} words of substance remain without the link.`
        : `Only ${remainingWords} of ${bodyWords} words remain without the link: the answer is the link.`,
  });

  // 3. A specific angle: coherent with the thread, and with the angle it was drafted for.
  const bodyTokens = contentTokens(body);
  const threadTokens = contentTokens(`${ctx.thread.title} ${ctx.thread.excerpt ?? ""}`);
  const threadOverlap = overlap(bodyTokens, threadTokens);
  const angleTokens = ctx.angle ? contentTokens(ctx.angle) : new Set<string>();
  const angleOverlap = overlap(bodyTokens, angleTokens);
  // A short reply under a post is judged lightly (2026-11-12): two shared
  // words is a fair bar for a forum answer, but a one-line reply on X that
  // answers the post's point in its own words ("building software and
  // seeing people pay for it" under a post about being called a grifter)
  // was blocked for not repeating "sometimes", "calling", "saying". One
  // shared word is enough there, and a miss is a warning, never a block:
  // the reading of the post, not a word count, is what keeps it on topic.
  const shortReply = draft.variant === "short_comment";
  const specific = threadOverlap.length >= (shortReply ? 1 : 2) && (ctx.angle === null || angleOverlap.length >= 1);
  const missedThread = suggestWords(threadTokens, bodyTokens);
  const missedAngle = suggestWords(angleTokens, bodyTokens);
  checks.push({
    id: "specific_angle",
    label: "Speaks to this thread and its angle, not a generic topic",
    status: specific ? "pass" : shortReply ? "warn" : "fail",
    detail: specific
      ? `Shares ${threadOverlap.length} terms with the thread${ctx.angle ? ` and ${angleOverlap.length} with the angle` : ""}.`
      : threadOverlap.length < (shortReply ? 1 : 2)
        ? `Barely overlaps with what the thread is about: it reads as a generic answer.${missedThread.length ? ` Use the thread's own words: ${missedThread.join(", ")}.` : ""}`
        : `Does not touch the angle it was qualified for.${missedAngle.length ? ` Use words from the angle: ${missedAngle.join(", ")}.` : ""}`,
  });

  // 4. Claims are explicit and verifiable.
  const unverified = draft.claims.filter((c) => c.basis === "unverified");
  const unverifiableLanguage = UNVERIFIABLE.test(body);
  // Experience is a claim too. It is verifiable only against what the
  // business recorded about the writer; with nothing recorded it is invented.
  const aboutYou = ctx.writer?.aboutYou.trim() ?? "";
  const experienceClaim = aboutYou ? null : (body.match(EXPERIENCE_CLAIMS)?.[0] ?? null);
  // A number is declared by a claim the drafter listed, or by About you:
  // what the person recorded, or confirmed with "It's true" (2026-11-12). A
  // figure of speech ("going 100% on") is no number at all
  // (lib/placements/numeric-claims.ts).
  const undeclaredNumbers = undeclaredNumberSentences(
    body,
    draft.claims.map((c) => c.text),
    aboutYou
  );
  // The sentences the person can confirm as true, one tap each: the numbers
  // nobody declared, and the experience claimed with nothing recorded.
  const experienceSentence = experienceClaim ? (allSentences.find((s) => EXPERIENCE_CLAIMS.test(s)) ?? null) : null;
  // An event of the writer's own with no number in it, money for something
  // they made, that About you does not record ("when someone paid for my
  // app"): an experience nobody recorded, About you filled or not
  // (lib/placements/first-hand-events.ts, 12 November 2026).
  const events = unrecordedEvents(body, aboutYou);
  const confirmable = [
    ...undeclaredNumbers,
    ...(experienceSentence && !undeclaredNumbers.includes(experienceSentence) ? [experienceSentence] : []),
    ...events.map((event) => event.sentence).filter((sentence) => !undeclaredNumbers.includes(sentence) && sentence !== experienceSentence),
  ];
  // A recorded fact is not licence to state it anywhere. The reply of
  // 10 November 2026 opened "12 paying stores for my own thing" on the
  // GetTrafficFast account, under a post about a hackathon: the figure was in
  // About you, about another product (Postwren), and a month old. Grounded
  // in the list and wrong for the post is a claim the reader is misled by,
  // so it fails here, with the invented ones (lib/placements/fact-fit.ts).
  const misfits = factProblems({
    body,
    aboutYou,
    thread: ctx.thread,
    businessName: ctx.business.name,
    ownNames: [...names, ...ctx.business.domains.map((domain) => domain.split(".")[0] ?? "")],
    expertise: ctx.expertise,
    now: ctx.now,
    confirmations: ctx.writer?.confirmedFacts,
  });
  const claimsOk =
    unverified.length === 0 &&
    undeclaredNumbers.length === 0 &&
    !unverifiableLanguage &&
    experienceClaim === null &&
    events.length === 0 &&
    misfits.length === 0;
  checks.push({
    id: "verifiable_claims",
    label: "Nothing invented, and your own facts only where they fit",
    status: claimsOk ? "pass" : "fail",
    ...(claimsOk || confirmable.length === 0 ? {} : { confirmable }),
    detail: claimsOk
      ? draft.claims.length > 0
        ? `${draft.claims.length} explicit claim(s), each with a stated basis.`
        : "No factual claims to verify."
      : [
          // First: the refusal message shows the start of this line.
          ...misfits.map((problem) => problem.detail),
          unverified.length ? `${unverified.length} claim(s) marked unverified.` : null,
          undeclaredNumbers.length ? `${undeclaredNumbers.length} sentence(s) with numbers not declared as claims.` : null,
          unverifiableLanguage ? 'Uses unverifiable language ("guaranteed", "studies show", "the best…").' : null,
          experienceClaim
            ? `Claims personal experience ("${experienceClaim}") but nothing about the writer is recorded in Settings → Voice.`
            : null,
          events.length
            ? `Claims something happened to you that About you does not record ("${events[0].quote}"). A feeling or an opinion is yours to state; a payment, a customer or a sale is a fact. Leave it out, or add it to About you if it is true.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
  });

  // 5. Who is named. A reply names no product: the 21 replies published
  // with one sentence naming it all read as the same disguised advert, and
  // a reader who wants to know who wrote a useful answer opens the profile.
  // Once is a refusal. The list entry and the article name the project
  // once: never is a refusal there, twice a warning, more is spam, below.
  const brandMentions = countMatches(body, brand);
  if (naming) {
    checks.push({
      id: "names_business",
      label: "Names the business once, as something the writer uses",
      status: brand === null || brandMentions === 1 ? "pass" : brandMentions === 0 ? "fail" : "warn",
      detail:
        brand === null
          ? "The business has no name recorded to look for."
          : brandMentions === 0
            ? `Never names ${ctx.business.name}. One clause, in the middle, is what makes this a placement.`
            : brandMentions === 1
              ? `Named once.`
              : `Named ${brandMentions} times; once is enough.`,
    });
  } else {
    checks.push({
      id: "names_business",
      label: "Names no product: the reply is the answer",
      status: brandMentions === 0 ? "pass" : "fail",
      detail:
        brand === null
          ? "The business has no name recorded to look for."
          : brandMentions === 0
            ? `Does not name ${businessName}. Readers who want to know who wrote it open the profile.`
            : `Names ${businessName}${brandMentions > 1 ? ` ${brandMentions} times` : ""}. A reply names no product and links nothing: every reply published with one sentence naming it read as an advert. Delete the clause that names it and put nothing in its place.`,
    });
  }

  // 6. Not spam.
  const capsWords = (body.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !["HTML", "JSON", "API", "SEO", "AEO", "URL", "HTTP", "HTTPS", "CSS"].includes(w));
  const exclamations = (body.match(/!/g) ?? []).length;
  const spamHits = [
    urls.length > 1 ? `${urls.length} links (at most one).` : null,
    brandMentions > 2 ? `Names the business ${brandMentions} times.` : null,
    SPAM_PHRASES.test(body) ? "Contains a marketing phrase." : null,
    capsWords.length > 3 ? "Shouts in capitals." : null,
  ].filter((h): h is string => Boolean(h));
  checks.push({
    id: "not_spam",
    label: "Reads like a person, not a campaign",
    status: spamHits.length > 0 ? "fail" : exclamations > 2 ? "warn" : "pass",
    detail:
      spamHits.length > 0
        ? spamHits.join(" ")
        : exclamations > 2
          ? "Several exclamation marks; tone it down."
          : naming
            ? "The brand named sparingly, no marketing phrases."
            : "No marketing phrases.",
  });

  // 7. Written by a participant, not by a marketer. The reason the check
  // exists: the first drafts passed every other line here and still read as
  // adverts — the pivot from the competitors, the benefits paragraph, the
  // soft close on the brand.
  const pitchPhrase = body.match(PITCH_PHRASES)?.[0] ?? null;
  // The "I use <product> for that" sentence, posted under all 21 published
  // replies. One occurrence is a refusal in every variant, the article
  // included: there the name is given in a clause of the article's own.
  const usedMention = campaignMention(body, names);
  const brandPitchRe = brandPitchPattern(names);
  const brandPitch = brandPitchRe ? (body.match(brandPitchRe)?.[0] ?? null) : null;
  // The maker speaking: "I work on X", "we built X", "our product", "full
  // disclosure". A refusal on its own, in every variant.
  const makerByName = makerByNamePattern(names);
  const makerVoice = body.match(MAKER_PHRASES)?.[0] ?? (makerByName ? (body.match(makerByName)?.[0] ?? null) : null);
  // The mention as the destination: an article whose last sentence is where
  // the brand appears. One tell, so a reviewer sees it; on its own it does
  // not block. A reply names nothing, so there it is check 5's refusal.
  const lastSentence = allSentences[allSentences.length - 1] ?? "";
  const closesOnBrand = naming && allSentences.length > 3 && countMatches(lastSentence, brand) > 0;
  const tells = aiTells(body, draft.variant);
  if (closesOnBrand) tells.push({ name: "closes on the business", sample: null });
  // The product described statement by statement is a brochure whatever the
  // wording. The model's own claim bookkeeping says how many statements are
  // about the product; at the limit it is a tell, over it a refusal. The
  // statements are quoted so a rewrite knows which sentences to drop.
  const productStatements = draft.claims.filter((c) => c.basis === "business_profile");
  const productClaims = productStatements.length;
  if (!listEntry && productClaims === PRODUCT_CLAIM_LIMIT) tells.push({ name: `${productClaims} statements about the product`, sample: null });
  const brochure = !listEntry && productClaims > PRODUCT_CLAIM_LIMIT;
  const quotedStatements = productStatements
    .slice(0, 4)
    .map((c) => `"${c.text.length > 90 ? `${c.text.slice(0, 87)}…` : c.text}"`)
    .join(", ");
  const tellLimit = draft.variant === "article_draft" ? 3 : 2;
  const pitched = pitchPhrase !== null || brandPitch !== null || makerVoice !== null;
  const voiceStatus: CheckStatus =
    pitched || usedMention !== null || brochure || tells.length >= tellLimit ? "fail" : tells.length > 0 ? "warn" : "pass";
  checks.push({
    id: "human_voice",
    label: naming ? "Written like a person who uses it, not a pitch" : "Written like a person, not a pitch",
    status: voiceStatus,
    detail:
      voiceStatus === "pass"
        ? "No sales phrasing, no maker speaking, none of the structures a promotional text falls into."
        : [
            pitchPhrase ? `Sales phrasing: "${pitchPhrase}".` : null,
            usedMention
              ? naming
                ? `"${usedMention}" is the "I use it for that" sentence already posted under every thread. If the business is named, it is in a clause of this text's own words.`
                : `"${usedMention}" is the "I use it for that" sentence already posted under every thread. A reply names no product: delete the sentence and put nothing in its place.`
              : null,
            brandPitch ? `Pitches the brand by name: "${brandPitch}".` : null,
            makerVoice
              ? naming
                ? `Speaks as the maker: "${makerVoice}". The text is written by someone who uses ${businessName}, never by someone who builds it.`
                : `Speaks as the maker: "${makerVoice}". A reply speaks for no product, least of all as the people who build it.`
              : null,
            brochure
              ? `Describes the product in ${productClaims} statements (${quotedStatements}${productClaims > 4 ? ", …" : ""}); a person mentions the one or two that fit.`
              : null,
            tells.length ? `Reads as written to promote, not to answer: ${tells.map(describeTell).join(", ")}.` : null,
          ]
            .filter(Boolean)
            .join(" "),
  });

  // 8. The link. A reply carries none, on any surface: any URL in the text,
  // or a link declared beside it, is a refusal. Reddit's own filter removed
  // the comments that had one, and everywhere else the profile is how a
  // reader finds the business. The list entry and the article carry one,
  // beside the name. A business with no site recorded has nothing to link
  // and is not refused for it.
  const site = ctx.business.domains[0] ?? null;
  const carriesUrl = variantCarriesLink(draft.variant, ctx.thread.surface);
  let linkStatus: CheckStatus = "pass";
  let linkDetail: string;
  const linkLabel = carriesUrl ? "One link to your own site, beside the name" : "No link in the reply";
  if (!carriesUrl) {
    if (hasUrl(body) || draft.linkUrl) {
      linkStatus = "fail";
      linkDetail =
        ctx.thread.surface === "reddit"
          ? "Reddit removes a comment that contains a link. Leave every URL out."
          : "A reply carries no link: readers find the business through the profile. Leave every URL out.";
    } else {
      linkDetail = "No URL in the reply.";
    }
  } else if (!draft.linkUrl) {
    if (site) {
      linkStatus = "fail";
      linkDetail = `No link to ${site}. One, in the clause that names ${businessName}, is part of the placement.`;
    } else {
      linkDetail = "The business has no site recorded, so there is nothing to link.";
    }
  } else {
    const host = domainOf(draft.linkUrl);
    const ours = ctx.business.domains.some((d) => isCompanySource(host, d));
    const inBody = body.includes(draft.linkUrl);
    const besideName = sentences(body).some((s) => s.includes(draft.linkUrl as string) && countMatches(s, brand) > 0);
    if (!ours) {
      linkStatus = "fail";
      linkDetail = `The link points at ${host || "an unknown host"}, not at a domain of the business.`;
    } else if (!inBody) {
      linkStatus = "fail";
      linkDetail = `The link to ${host} is declared but does not appear in the text.`;
    } else if (brand && !besideName) {
      linkStatus = "warn";
      linkDetail = `One link to ${host}, but not in the sentence that names ${ctx.business.name}; a person links the name.`;
    } else {
      linkDetail = `One link to ${host}, beside the name.`;
    }
  }
  checks.push({ id: "link", label: linkLabel, status: linkStatus, detail: linkDetail });

  // 9. Coherent with what the business knows.
  const expertiseTokens = contentTokens([...ctx.expertise, ...ctx.business.brandNames].join(" "));
  const expertiseOverlap = overlap(bodyTokens, expertiseTokens);
  checks.push({
    id: "business_coherence",
    label: "Coherent with what the business can speak to",
    status: ctx.expertise.length === 0 || expertiseOverlap.length > 0 ? "pass" : "warn",
    detail:
      ctx.expertise.length === 0
        ? "No expertise recorded for this business yet."
        : expertiseOverlap.length > 0
          ? `Touches ${expertiseOverlap.length} of the business's own topics.`
          : "Does not touch any of the business's keywords or entities. A note, not a fault: a reply speaks from the writer, and this never blocks or asks for a rewrite.",
  });

  // 10. Right length and tone for the platform.
  const limits = LENGTH_LIMITS[draft.variant];
  const onX = ctx.thread.surface === "x" && draft.variant === "short_comment";
  const maxChars = onX ? X_LIMIT : limits.maxChars;
  const length = onX ? xLength(body) : body.length;
  const tooShort = bodyWords < limits.minWords;
  const tooLong = length > maxChars;
  checks.push({
    id: "platform_fit",
    label: "Fits the platform's length and tone",
    status: tooShort || tooLong ? "fail" : "pass",
    detail: tooShort
      ? `${bodyWords} words is too short for a ${draft.variant.replace("_", " ")} (at least ${limits.minWords}).`
      : tooLong
        ? `${length} characters is too long for ${ctx.thread.surface} (at most ${maxChars}${onX ? ", a link counting as 23" : ""}).`
        : `${bodyWords} words, ${length} characters.`,
  });

  // 11. Nothing is posted on its own. Structural, and stated so the reviewer knows.
  checks.push({
    id: "manual_publish",
    label: "Published by you, never on its own",
    status: "pass",
    detail:
      ctx.thread.surface === "x"
        ? "Nothing goes out until you act: you open X and post it, or, where the post mentions the X account you connected, you press Post on X and GTF posts this text from it, once."
        : "The platform has no credentials for this surface and no code path that posts. You copy, you open the original, you publish.",
  });

  // 12. The writer's own notes, where code can read them (lowercase, for
  // now). A style rule: the rewrite is asked to follow it, the verdict
  // ignores it (STYLE_CHECKS).
  checks.push(notesCheck(body, draft.variant, ctx.writer?.instructions ?? ""));

  // 13. Only on a rewrite made from the owner's note: does it follow the
  // note, or answer it? The rewrite of 10 November 2026 opened "that's
  // exactly how i interpret these posts too" and kept "the struggle of
  // getting traction", the words the note said were wrong. Counted like the
  // voice check: a reply that quotes or answers the note cannot be posted
  // as it is, so that is a refusal; an opening that merely agrees with
  // someone is a warning.
  if (ctx.correction?.trim()) {
    const misses = correctionProblems(body, ctx.correction);
    checks.push({
      id: "follows_your_correction",
      label: "Follows your correction, and does not answer it",
      status: misses.some((miss) => miss.severity === "fail") ? "fail" : misses.length > 0 ? "warn" : "pass",
      detail:
        misses.length > 0
          ? misses.map((miss) => miss.detail).join(" ")
          : "Nothing of your correction's wording is in the reply, and it does not answer it.",
    });
  }

  // 14. Only when the recent replies were read: does the draft use a fact
  // from About you that 2 or more of the last 10 replies already used? On
  // 12 November 2026 5 of the last 17 drafts said "position 30-40", the last
  // under a post about being called a grifter. Advisory: the fact is true,
  // so it never blocks, but the draft loop asks one rewrite to fix it.
  if (ctx.recentFacts) {
    const repeats = repeatedFacts(body, aboutYou, ctx.recentFacts, {
      now: ctx.now,
      post: `${ctx.thread.title} ${ctx.thread.excerpt ?? ""}`,
    });
    checks.push({
      id: REPEATS_RECENT_FACT,
      label: "Repeats a recent fact",
      status: repeats.length > 0 ? "fail" : "pass",
      detail:
        repeats.length > 0
          ? repeats.map((repeat) => repeat.detail).join(" ")
          : ctx.recentFacts.replies === 0
            ? "No recent replies to compare with."
            : `Uses no fact of yours that is already in 2 or more of your last ${ctx.recentFacts.replies} replies.`,
    });
  }

  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2 };
  // Every check says whether it is advisory, so the inbox can show a note
  // as a note and leave it out of "All checks passed".
  const flagged = checks
    .map((check) => ({ ...check, advisory: ADVISORY_CHECKS.has(check.id) }))
    .sort((a, b) => order[a.status] - order[b.status]);
  const counted = flagged.filter(countsTowardVerdict);
  const status = counted.some((c) => c.status === "fail")
    ? "blocked"
    : counted.some((c) => c.status === "warn")
      ? "warning"
      : "passed";
  return { status, checks: flagged };
}

/**
 * The phrases a model reaches for when it has nothing to say, in an article.
 *
 * The same idea as the Placements tell-list (`AI_TELLS`, lib/placements/
 * audit.ts), kept as its own list: a reply under a post and a 1,200-word
 * article fail in different words, and the two layers do not import each
 * other. Every entry here was read in an article production published
 * (audit of 2026-11-10) or is the same sentence in Italian.
 *
 * Detectors only. A hit names the phrase to the revision pass; nothing here
 * rewrites a character of the article.
 */

export interface Tell {
  name: string;
  pattern: RegExp;
}

export const ARTICLE_TELLS: Tell[] = [
  {
    // "In today's competitive digital landscape…"
    name: "in today's … landscape",
    pattern:
      /\bin today[’']?s\s+(?:[a-z-]+\s+){0,4}(?:landscape|world|age|era|market(?:place)?|environment|economy)\b/i,
  },
  {
    // "The landscape of content creation is rapidly evolving…"
    name: "the landscape of … is evolving",
    pattern:
      /\bthe\s+(?:landscape|world|realm|field)\s+of\s+[^.!?]{1,80}?\s+(?:is|has been|keeps?|continues to)\s+(?:rapidly\s+|constantly\s+|quickly\s+|ever\s+)?(?:evolv|chang|shift|transform)/i,
  },
  {
    name: "ever-evolving",
    pattern: /\b(?:ever|rapidly|constantly|fast)[- ](?:evolving|changing)\s+(?:landscape|world|market|field|industry|space)\b/i,
  },
  {
    // "…no longer a luxury but a strategic necessity"
    name: "no longer a luxury but a necessity",
    pattern: /\bno longer\s+(?:just\s+|merely\s+)?(?:a\s+)?(?:luxury|nice[- ]to[- ]have|an?\s+option|optional)\b[^.!?]{0,40}\b(?:necessity|must(?:[- ]have)?|essential|imperative)\b/i,
  },
  { name: "strategic necessity", pattern: /\b(?:strategic|business|competitive)\s+(?:necessity|imperative)\b/i },
  {
    // "GetTrafficFast offers an unparalleled solution"
    name: "an unparalleled solution",
    pattern:
      /\b(?:offers?|provides?|delivers?|is)\s+(?:an?|the)\s+(?:unparalleled|unmatched|unrivall?ed|comprehensive|powerful|robust|cutting[- ]edge|all[- ]in[- ]one|game[- ]changing|ultimate|perfect)\s+(?:solution|platform|tool|answer|choice)\b/i,
  },
  { name: "unparalleled", pattern: /\b(?:unparalleled|unrivall?ed|second to none|best[- ]in[- ]class|world[- ]class)\b/i },
  { name: "game-changer", pattern: /\bgame[- ]chang(?:er|ers|ing)\b/i },
  { name: "unlock the potential", pattern: /\bunlock(?:s|ing)?\s+(?:the\s+|your\s+)?(?:full\s+|true\s+)?(?:potential|power|secrets?)\b/i },
  { name: "take … to the next level", pattern: /\btake\s+[^.!?]{1,40}\s+to\s+the\s+next\s+level\b/i },
  { name: "look no further", pattern: /\blook no further\b/i },
  { name: "in the realm of", pattern: /\bin the (?:realm|world) of\b/i },
  { name: "navigating the landscape", pattern: /\bnavigat(?:e|es|ing)\s+the\s+(?:complex\s+|complexities of\s+)?(?:[a-z-]+\s+){0,3}(?:landscape|world|waters|maze)\b/i },
  { name: "let's dive in", pattern: /\b(?:let[’']?s|we(?:[’']ll| will))\s+(?:dive|delve)\s+(?:in|into|deeper)\b/i },
  { name: "delve", pattern: /\bdelv(?:e|es|ing)\s+into\b/i },
  { name: "in conclusion", pattern: /(?:^|[.!?]\s+)(?:in conclusion|to sum up|in summary|all in all)\s*,/im },
  { name: "it's important to note", pattern: /\bit[’']?s\s+(?:important|worth|crucial)\s+(?:to\s+note|noting|to\s+remember)\b/i },
  { name: "whether you're a … or a …", pattern: /\bwhether you[’']?re\s+an?\s+[^.!?,]{1,40}\s+or\s+an?\s+/i },
  // The same sentences in Italian: the platform writes in the site's language.
  { name: "nel panorama … di oggi", pattern: /\bnel(?:l[’'])?\s*(?:panorama|mondo|contesto|mercato)\s+(?:[a-zà-ù-]+\s+){0,3}(?:odierno|attuale|di oggi|digitale|competitivo)\b/i },
  { name: "non è più un lusso", pattern: /\bnon\s+è\s+più\s+un\s+lusso\b/i },
  { name: "in un mondo sempre più", pattern: /\bin un (?:mondo|mercato|panorama) sempre più\b/i },
  { name: "soluzione senza pari", pattern: /\b(?:soluzione|piattaforma)\s+(?:senza\s+(?:pari|eguali|rivali)|impareggiabile|all[’']avanguardia)\b/i },
];

export interface TellHit {
  name: string;
  /** The words that tripped it, for the revision to recognise. */
  sample: string;
}

export function articleTells(text: string): TellHit[] {
  const plain = text.replace(/[‘’]/g, "'");
  const hits: TellHit[] = [];
  for (const tell of ARTICLE_TELLS) {
    const match = plain.match(tell.pattern);
    if (match) hits.push({ name: tell.name, sample: match[0].replace(/^[.!?\s]+/, "").trim() });
  }
  return hits;
}

/** Words a title must not lean on: each one promises more than an article delivers. */
export const BANNED_TITLE_WORDS =
  /\b(mastering|unlock(?:s|ed|ing)?|ultimate|definitive|blueprint|unleash(?:es|ed|ing)?)\b/i;

/** Longer than this and a search result cuts the title. */
export const MAX_TITLE_LENGTH = 60;

export function bannedTitleWord(title: string): string | null {
  return title.match(BANNED_TITLE_WORDS)?.[1] ?? null;
}

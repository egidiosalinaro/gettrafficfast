import type { RuleOutcome, RuleTarget } from "./rules";

/**
 * What makes an X post a conversation an expert answer helps, and what makes
 * it noise (docs/PLACEMENTS.md, "Conversations, not noise", 2026-11-14).
 *
 * Two uses, one vocabulary per language:
 *   - the daily search ANDs the site's topics with the phrases people use
 *     when they ask or struggle ("how do I", "anyone know", "struggling"),
 *     and leaves out the obvious adverts with X's own negation, so X returns
 *     (and bills) fewer posts that were never questions;
 *   - before the paid qualifier, `xNoiseRule` drops, by rules alone, what
 *     still comes back and is plainly not a conversation: an advert or a
 *     sale, a link shared with a line, a statement to nobody, a list dump,
 *     a post too short to know what is asked. Each drop is a stored
 *     rejection with its rule's name, as every rules rejection is.
 *
 * Measured on the first two runs (2026-11-12 and 2026-11-13: 24 posts, 20
 * rejected by the model as adverts, news, jokes, anecdotes, sales); the
 * effect on later runs is not measured yet. Pure: no I/O.
 */

interface Vocabulary {
  /**
   * Phrases OR-ed in the search. Exact phrases, no apostrophe (how X
   * tokenises one is not documented), short enough that the group fits
   * beside the topics in 512 characters.
   */
  query: string[];
  /** Phrases that mark a question or a problem in the text itself, wider than the query's. */
  signal: RegExp;
  /** Someone speaking to someone, or about themselves: not a headline. */
  address: RegExp;
}

const VOCABULARY: Record<string, Vocabulary> = {
  en: {
    query: [
      '"how do i"',
      '"how do you"',
      '"anyone know"',
      '"does anyone"',
      '"anyone tried"',
      '"anyone using"',
      '"any tips"',
      '"any advice"',
      '"should i"',
      '"best way to"',
      "struggling",
      '"need help"',
      '"which tool"',
      '"worth it"',
    ],
    signal:
      /\b(how (do|can|should|would) (i|you|we)|any ?(one|body) (know|tried|using|use|else|have|got|recommend)|does any ?(one|body)|has any ?(one|body)|can some ?one|any (tips|advice|ideas|recommendations?)|should i|is it worth|worth it\b|best way to|what('?s| is) the best|which (tool|one|platform|app)|struggl\w*|need help|help me|can'?t figure|stuck (on|with)|what am i (doing|missing)|thoughts\?)/i,
    address: /\b(you|your|you're|yours|i|i'm|i've|i'd|im|my|me|we|we're|our|us|anyone|anybody|everyone|someone)\b/i,
  },
  it: {
    query: [
      '"come faccio"',
      '"come fate"',
      '"qualcuno sa"',
      '"qualcuno ha"',
      '"qualcuno usa"',
      "consigli",
      "consigliate",
      '"non riesco"',
      '"mi aiutate"',
      '"che ne pensate"',
      '"vale la pena"',
    ],
    signal:
      /\b(come (faccio|fate|si fa|posso)|qualcuno (sa|ha|usa|conosce|mi)|consigli\w*|non riesco|mi aiutate|aiuto|che ne pensate|vale la pena|quale (tool|strumento|piattaforma)|meglio usare)/i,
    address: /\b(tu|tuo|tua|voi|vostro|vostra|io|mio|mia|miei|noi|nostro|nostra|qualcuno|chi|ho|sono|avete|siete)\b/i,
  },
  es: {
    query: [
      '"cómo hago"',
      '"alguien sabe"',
      '"alguien ha"',
      '"alguien usa"',
      "consejos",
      "recomiendan",
      '"no consigo"',
      '"necesito ayuda"',
      '"qué opinan"',
      '"vale la pena"',
    ],
    signal:
      /(c[oó]mo (hago|hacen|puedo)|alguien (sabe|ha|usa|conoce|me)|consejos?|recomiend\w*|no (consigo|logro)|necesito ayuda|qu[eé] opinan|vale la pena|qu[eé] herramienta)/i,
    address: /\b(tú|tu|tus|usted|ustedes|vosotros|yo|mi|mis|nosotros|nuestro|nuestra|alguien|tengo|estoy)\b/i,
  },
  fr: {
    query: [
      '"comment faire"',
      '"comment vous"',
      '"vous conseillez"',
      '"des conseils"',
      '"vos avis"',
      '"je galère"',
      '"je cherche"',
      '"besoin aide"',
    ],
    signal: /(comment (faire|vous|je|on)|quelqu.un (sait|a|utilise|conna[iî]t)|conseil\w*|vos avis|je gal[eè]re|je cherche|besoin d.aide|vaut le coup|quel outil)/i,
    address: /\b(tu|toi|ton|ta|tes|vous|votre|vos|je|j|moi|mon|ma|mes|nous|notre|nos|quelqu)\b/i,
  },
  de: {
    query: [
      '"wie macht"',
      '"kennt jemand"',
      '"hat jemand"',
      '"weiß jemand"',
      "tipps",
      "empfehlungen",
      '"ich suche"',
      '"brauche hilfe"',
      '"lohnt sich"',
    ],
    signal: /(wie (macht|mache|kann|geht)|(kennt|hat|wei[sß]+|nutzt) jemand|tipps?\b|empfehl\w*|ich suche|brauche hilfe|lohnt (sich|es)|welches tool)/i,
    address: /\b(du|dein|deine|ihr|euer|eure|sie|ich|mein|meine|mir|mich|wir|unser|unsere|jemand)\b/i,
  },
  pt: {
    query: [
      '"como faço"',
      '"alguém sabe"',
      '"alguém usa"',
      '"alguém já"',
      "dicas",
      "recomendam",
      '"preciso de ajuda"',
      '"não consigo"',
      '"vale a pena"',
    ],
    signal: /(como (fa[cç]o|voc[eê]s|posso)|algu[eé]m (sabe|usa|j[aá]|conhece|me)|dicas?\b|recomend\w*|preciso de ajuda|n[aã]o consigo|vale a pena|qual ferramenta)/i,
    address: /\b(você|voce|vocês|tu|teu|tua|seu|sua|eu|meu|minha|nós|nosso|nossa|alguém|tenho|estou)\b/i,
  },
};

/** The site's language as the two letters the vocabulary is keyed by. */
function langKey(language: string | null | undefined): string {
  return (language || "en").slice(0, 2).toLowerCase();
}

/**
 * The phrases a search ANDs with the topics, for the site's language. Empty
 * for a language without a vocabulary: the search then asks for the topics
 * alone, as before 2026-11-14, and the pre-filter's shape rules stay off.
 */
export function xConversationPhrases(language: string | null | undefined): string[] {
  return VOCABULARY[langKey(language)]?.query ?? [];
}

/**
 * Words X leaves out of a search with `-word`: what the qualifier rejected as
 * adverts on the first runs (sales "wts/wtb", giveaways, link-in-bio,
 * airdrops). Kept short, each one a word no question needs: "course" or
 * "hiring" are not here, because "of course" and "a recruiter hiring for"
 * sit in genuine posts; the pre-filter reads those in context instead.
 */
export const X_EXCLUDED_WORDS = [
  "giveaway",
  "airdrop",
  "wts",
  "wtb",
  '"for sale"',
  '"link in bio"',
  '"dm me"',
  '"promo code"',
  '"discount code"',
  "webinar",
];

// ── The pre-filter ──────────────────────────────────────────────────────────

/**
 * Adverts, sales, giveaways, hiring and course dumps. Read over the whole
 * text, so each pattern is one no question needs ("we're hiring", not
 * "hiring"; "free courses", not "course").
 */
const PROMO =
  /\b(wts|wtb|lfs|lfb|for sale|giveaway|airdrop|promo code|discount code|coupon|\d{1,2}% off|link in (my )?bio|dm (me|us|for)|free early access|sign up (now|today|for free)|register (now|today|here)|book a (free )?(call|demo)|limited (spots|seats|offer)|fill (out|in) the form|our team will (reach|contact|get)|(paid|free) courses?|free (webinar|masterclass|workshop|ebook)|(join|register for) (our|my|the) (free )?(webinar|masterclass|workshop)|we('| a)re hiring|now hiring|job opening|follow (me|us)\b|follow (my|our) (\w+ )?(account|page|channel|instagram|tiktok|youtube)|onlyfans|nsfw|casino|betting tips)\b/i;

/** "At Acme, our SEO services help…": a business speaking about its own offer. */
const OWN_OFFER = /\b([Aa]t [A-Z][\w.&-]+, (our|we)\b|our [\w\s()&,-]{0,80}\bservices? (help|helps|can))/;

const URL = /https?:\/\/\S+/g;
const MENTION = /(^|\s)@\w+/g;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
/** A line that starts a numbered or bulleted item. */
const LIST_ITEM = /^\s*(\d{1,3}[.)]|[-•▪●◦*])\s+\S/gm;

/** Fewer words than this, links, mentions and hashtags aside: nothing to answer. */
export const X_MIN_WORDS = 5;
/** A link with no more words than this, no question and no problem in it: a share, not a conversation. */
export const X_LINK_SHARE_MAX_WORDS = 40;
/** This many hashtags or more: a post written for reach, not for an answer. */
export const X_MAX_HASHTAGS = 5;
/** This many list items or more, and no question: a list dump. */
export const X_LIST_DUMP_ITEMS = 10;

/** The words a person wrote: links, mentions and hashtags removed. */
function proseWords(text: string): string[] {
  return text
    .replace(URL, " ")
    .replace(MENTION, " ")
    .replace(HASHTAG, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

export interface XShape {
  words: number;
  links: number;
  hashtags: number;
  listItems: number;
  question: boolean;
  signal: boolean;
  address: boolean | null;
}

/** What the pre-filter reads off a post's text. `address` is null in a language without a vocabulary. */
export function xPostShape(text: string, language: string | null | undefined): XShape {
  const vocabulary = VOCABULARY[langKey(language)];
  const prose = proseWords(text).join(" ").replace(/[\u2018\u2019]/g, "'");
  return {
    words: proseWords(text).length,
    links: (text.match(URL) ?? []).length,
    hashtags: (text.match(HASHTAG) ?? []).length,
    listItems: (text.match(LIST_ITEM) ?? []).length,
    question: /[?？¿]/.test(prose),
    signal: vocabulary ? vocabulary.signal.test(prose) : false,
    address: vocabulary ? vocabulary.address.test(prose) : null,
  };
}

const reject = (rule: string, reason: string): RuleOutcome => ({ status: "rejected", rule, reason });

/**
 * The rules-only pre-filter for a post the X search found, run after the
 * shared rules and before the paid qualifier. Null when the post passes.
 * Each rejection names its rule (`x_promo`, `x_too_short`, `x_list_dump`,
 * `x_link_share`, `x_broadcast`) and is stored like any rules rejection.
 * A question or a problem in the text protects a post from the shape rules:
 * only the advert, length and hashtag rules override it. In a language
 * without a vocabulary (Japanese has no spaces to count words by) the words
 * cannot be counted or read: only the advert, hashtag and list rules apply.
 */
export function xNoiseRule(target: Pick<RuleTarget, "title" | "excerpt">, language: string | null | undefined): RuleOutcome | null {
  // NFKC folds the "𝗣𝗮𝗶𝗱 𝗖𝗼𝘂𝗿𝘀𝗲" kind of styled letters back to words; curly apostrophes become straight.
  const text = (target.excerpt?.trim() || target.title || "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'");
  const shape = xPostShape(text, language);
  const known = shape.address !== null;
  const conversational = shape.question || shape.signal;

  if (PROMO.test(text) || OWN_OFFER.test(text)) {
    return reject("x_promo", "An advert, a sale, a giveaway, a course or a job post on X: nobody there is asking for an answer.");
  }
  if (known && shape.words < X_MIN_WORDS) {
    return reject("x_too_short", `Fewer than ${X_MIN_WORDS} words of its own on X: too little to know what is being asked.`);
  }
  // A run of hashtags is written for reach, whatever rhetorical question it asks.
  if (shape.hashtags >= X_MAX_HASHTAGS) {
    return reject("x_list_dump", `${shape.hashtags} hashtags: a post written for reach, not a question.`);
  }
  if (conversational) return null;
  if (shape.listItems >= X_LIST_DUMP_ITEMS) {
    return reject("x_list_dump", "A long list posted for reach, with no question in it.");
  }
  if (!known) return null;
  if (shape.links > 0 && shape.words <= X_LINK_SHARE_MAX_WORDS) {
    return reject("x_link_share", "A link shared with a line (news, an article, a product), with no question or problem in it.");
  }
  if (shape.address === false) {
    return reject("x_broadcast", "A statement to nobody (a headline or an announcement), with no question and no one speaking to anyone.");
  }
  return null;
}

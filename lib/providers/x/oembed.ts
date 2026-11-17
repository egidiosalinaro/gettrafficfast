import { HTMLElement, NodeType, parse, type Node } from "node-html-parser";
import { z } from "zod";

/**
 * Reading one public post on X through X's own oEmbed endpoint.
 *
 * `publish.twitter.com/oembed` is what every site that embeds a post calls:
 * free, official, no key, and it answers with the post as X itself renders
 * it for an embed. It is not scraping, and it is not a search: one URL in,
 * that post out, or nothing. A protected or deleted post, a post X will not
 * embed, a timeout, or an answer that does not have the expected shape all
 * read as "could not read it" (null), never as an empty post.
 *
 * The embed's `html` is a blockquote: the post's text in a `<p>` (line
 * breaks as `<br>`, mentions, hashtags and links as anchors whose text is
 * what the reader sees), then "— Name (@handle)" and an anchor to the post
 * whose text is the day it was posted.
 */

export const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";

/** Long enough for a slow answer, short enough that a person is not left waiting on X. */
export const OEMBED_TIMEOUT_MS = 6_000;

export interface XPost {
  /** The post's text as a reader sees it, line breaks kept, media links dropped. */
  text: string;
  /** The display name ("Jane Doe"), when the embed gives one. */
  authorName: string | null;
  /** The account, without "@", read from `author_url`. */
  handle: string | null;
  /**
   * The day the embed prints under the post, as UTC midnight of that day
   * (precision: a day, the way a search engine's calendar date is stored).
   * Null when there is no date line or it does not read as one.
   */
  postedOn: string | null;
  /**
   * True when the embed shows a media link ("pic.twitter.com/…" or
   * "pic.x.com/…"): the post carries a photo, a video or a GIF. The embed
   * never carries the image itself, nor how many there are. Absent on a
   * post built elsewhere: not known.
   */
  hasMedia?: boolean;
  /**
   * The links in the post's text, in order, media links left out: where each
   * points (`href`, often a t.co short link) and what the reader sees. A post
   * that quotes another shows it this way in the embed: a link, usually the
   * last, to the quoted post (lib/placements/referenced.ts reads it). Absent
   * on a post built elsewhere: not known.
   */
  links?: Array<{ href: string; text: string }>;
}

const OembedPayload = z.object({
  html: z.string().min(1),
  author_name: z.string().optional().nullable(),
  author_url: z.string().optional().nullable(),
});

export function oembedUrl(postUrl: string): string {
  const params = new URLSearchParams({ url: postUrl, omit_script: "1", dnt: "true" });
  return `${OEMBED_ENDPOINT}?${params.toString()}`;
}

/** The account in `https://twitter.com/<handle>`, or null. */
export function handleFromAuthorUrl(authorUrl: string | null | undefined): string | null {
  if (!authorUrl) return null;
  try {
    const url = new URL(authorUrl);
    const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
    if (host !== "twitter.com" && host !== "x.com") return null;
    const [handle, ...rest] = url.pathname.split("/").filter(Boolean);
    return handle && rest.length === 0 && /^\w{1,15}$/.test(handle) ? handle : null;
  } catch {
    return null;
  }
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "November 1, 2024" (the embed's date line, in English) as UTC midnight of that day. */
export function embedDay(text: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0 || year < 2006 || year > 2100) return null;
  const at = new Date(Date.UTC(year, month, day));
  if (at.getUTCMonth() !== month || at.getUTCDate() !== day) return null;
  return at.toISOString();
}

/** A media attachment is shown in the embed as a "pic.twitter.com/…" link: not words of the post. */
function isMediaLink(anchor: HTMLElement): boolean {
  return /^(https?:\/\/)?pic\.(twitter|x)\.com\//i.test(anchor.text.trim());
}

function textOf(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      out += node.text;
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName?.toLowerCase();
    if (tag === "br") out += "\n";
    else if (tag === "a" && isMediaLink(node)) continue;
    else out += textOf(node.childNodes);
  }
  return out;
}

/** Spaces tidied inside each line, blank runs reduced to one empty line, ends trimmed. */
function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the embed's text links a media attachment ("pic.twitter.com/…", "pic.x.com/…"). */
export function embedHasMedia(html: string): boolean {
  const root = parse(html);
  const paragraph = root.querySelector("blockquote p");
  if (!paragraph) return false;
  return paragraph.querySelectorAll("a").some((anchor) => isMediaLink(anchor));
}

/** The links of an embed's text, in order, media links left out. */
export function embedLinks(html: string): Array<{ href: string; text: string }> {
  const root = parse(html);
  const paragraph = root.querySelector("blockquote p");
  if (!paragraph) return [];
  return paragraph
    .querySelectorAll("a")
    .filter((anchor) => !isMediaLink(anchor))
    .map((anchor) => ({ href: (anchor.getAttribute("href") ?? "").trim(), text: anchor.text.trim() }))
    .filter((link) => link.href.length > 0);
}

/**
 * The text and the date line of an embed's blockquote. The HTML is parsed,
 * never pattern-matched, and only text comes out: entities decoded, tags
 * gone, `<br>` as a line break, an anchor as the words it shows.
 */
export function postFromEmbedHtml(html: string): { text: string; postedOn: string | null } {
  const root = parse(html);
  const quote = root.querySelector("blockquote");
  if (!quote) return { text: "", postedOn: null };
  const paragraph = quote.querySelector("p");
  const text = paragraph ? tidy(textOf(paragraph.childNodes)) : "";
  // The date line is the last direct link of the blockquote, the one to the post.
  const links = quote.childNodes.filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.tagName?.toLowerCase() === "a"
  );
  const dateLink = links.reverse().find((a) => /\/status(es)?\/\d+/.test(a.getAttribute("href") ?? ""));
  return { text, postedOn: dateLink ? embedDay(dateLink.text) : null };
}

/** An oEmbed answer as a post, or null when it carries no text to work from. */
export function parseOembed(payload: unknown): XPost | null {
  const parsed = OembedPayload.safeParse(payload);
  if (!parsed.success) return null;
  const { text, postedOn } = postFromEmbedHtml(parsed.data.html);
  if (!text) return null;
  return {
    text,
    authorName: parsed.data.author_name?.trim() || null,
    handle: handleFromAuthorUrl(parsed.data.author_url),
    postedOn,
    hasMedia: embedHasMedia(parsed.data.html),
    links: embedLinks(parsed.data.html),
  };
}

/**
 * The post at `postUrl`, or null when X does not hand it over. Never throws:
 * the caller has a fallback (the text the person pasted) and needs only to
 * know whether it has to use it.
 */
export async function readXPost(
  postUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<XPost | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OEMBED_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(oembedUrl(postUrl), { headers: { Accept: "application/json" }, signal });
    if (!response.ok) return null;
    return parseOembed(await response.json());
  } catch {
    return null;
  }
}

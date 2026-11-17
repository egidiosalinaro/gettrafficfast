/**
 * Minimal HTML -> Markdown conversion for the "Copy Markdown" fallback.
 * Covers the tags Gemini emits in generated articles (headings, paragraphs,
 * links, emphasis, lists, code, blockquotes). Anything unknown is stripped.
 */

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function htmlToMarkdown(html: string): string {
  let md = html;

  md = md.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  md = md.replace(/<!--[\s\S]*?-->/g, "");
  md = md.replace(/\r\n?/g, "\n");

  // Inline elements first, so their markers survive block processing.
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  md = md.replace(
    /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)"
  );
  md = md.replace(
    /<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi,
    "![$2]($1)"
  );

  // Block elements.
  for (let level = 6; level >= 1; level--) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    md = md.replace(re, (_m, inner: string) => {
      return `\n\n${"#".repeat(level)} ${inner.trim()}\n\n`;
    });
  }
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return `\n\n> ${text}\n\n`;
  });
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  md = md.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  md = md.replace(/<\/p>/gi, "\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  // Drop every remaining tag, then tidy whitespace.
  md = md.replace(/<[^>]+>/g, "");
  md = decodeEntities(md);
  md = md
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return md;
}

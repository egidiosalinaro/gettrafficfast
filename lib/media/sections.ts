import { HTMLElement, parse } from "node-html-parser";
import { clampText } from "@/lib/content/text";

/**
 * The text of each section of an article body, by heading id: what the
 * image-brief agent reads to decide what a section's picture shows. A
 * heading alone ("Getting started") says nothing about what is in the
 * section; the paragraphs under it do.
 *
 * A section runs from its heading to the next h2/h3. Each excerpt is cut to
 * `maxLength` characters: enough to see what the section is about, bounded so
 * a long article does not multiply the prompt.
 */
export function sectionExcerpts(bodyHtml: string, maxLength = 500): Record<string, string> {
  const root = parse(bodyHtml, { comment: false });
  const excerpts: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) excerpts[current] = clampText(buffer.join(" "), maxLength);
    buffer = [];
  };

  for (const node of root.childNodes) {
    if (!(node instanceof HTMLElement) || !node.tagName) continue;
    const tag = node.tagName.toUpperCase();
    if (tag === "H2" || tag === "H3") {
      flush();
      current = node.getAttribute("id") ?? null;
      continue;
    }
    if (tag === "FIGURE") continue; // captions of images already placed are not the section's text
    if (current) buffer.push(node.text);
  }
  flush();

  return excerpts;
}

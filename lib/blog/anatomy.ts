import { HTMLElement, parse } from "node-html-parser";
import { isReadNextHeading, isShortVersionLabel } from "@/lib/content/anatomy";

/**
 * How the blog shows the article's anatomy (docs/BLOG.md, "The article's
 * anatomy"): the short version as a boxed answer under the title, and the
 * Read next block as the post's own navigation.
 *
 * Presentation only, on the parsed tree of a body already sanitised
 * (`sanitizeBlogHtml`): it adds a class to the short-version paragraph and
 * wraps the Read next heading and its list in a `<nav>`. No word of the
 * article changes, and a body without either part comes back as it was.
 */

const tagOf = (node: unknown): string =>
  node instanceof HTMLElement ? (node.tagName?.toUpperCase() ?? "") : "";

export function decorateArticleBody(bodyHtml: string): string {
  const root = parse(bodyHtml, { comment: false });
  const blocks = root.childNodes.filter((node): node is HTMLElement => node instanceof HTMLElement);

  // The short version: the first block that is not the hero, when it opens with the label.
  const first = blocks.find((block) => tagOf(block) !== "FIGURE");
  if (first && tagOf(first) === "P") {
    const lead = first.childNodes.find((child) => child instanceof HTMLElement || child.text.trim() !== "");
    if (lead instanceof HTMLElement && ["STRONG", "B"].includes(tagOf(lead)) && isShortVersionLabel(lead.text)) {
      first.setAttribute("class", "gtf-short-version");
    }
  }

  // Read next: its heading and everything after it, inside one <nav>.
  const at = blocks.findIndex(
    (block) => tagOf(block) === "H2" && isReadNextHeading({ id: block.getAttribute("id"), text: block.text })
  );
  if (at !== -1) {
    const heading = blocks[at];
    const id = heading.getAttribute("id") ?? "read-next";
    const nav = parse(`<nav class="gtf-read-next" aria-labelledby="${id.replace(/"/g, "")}"></nav>`).firstChild as HTMLElement;
    const start = root.childNodes.indexOf(heading);
    const moved = root.childNodes.slice(start);
    root.childNodes.splice(start, moved.length, nav);
    nav.parentNode = root;
    for (const node of moved) {
      node.parentNode = nav;
      nav.childNodes.push(node);
    }
  }
  return root.toString();
}

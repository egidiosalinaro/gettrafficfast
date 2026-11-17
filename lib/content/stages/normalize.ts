import { marked } from "marked";
import { PipelineIssue } from "../types";

/**
 * Stage 3 — Normalization.
 *
 * Converts whatever the model produced into HTML using a real Markdown parser
 * (GFM). This is deliberately format-agnostic: the model may emit Markdown,
 * HTML, or a mix of both, and a CommonMark/GFM parser handles all three —
 * inline HTML passes through untouched, Markdown constructs become their HTML
 * equivalents, and loose text is wrapped in paragraphs.
 *
 * There is intentionally no hand-written substitution here. Headings, lists,
 * emphasis, blockquotes, code, links, images and tables are all the parser's
 * job; adding regexes on top is exactly what made the previous pipeline
 * unpredictable.
 */

marked.setOptions({
  gfm: true,
  breaks: false,
});

export interface NormalizeResult {
  html: string;
  issues: PipelineIssue[];
}

export function normalizeToHtml(input: string): NormalizeResult {
  const html = marked.parse(input, { async: false }) as string;
  return { html: html.trim(), issues: [] };
}

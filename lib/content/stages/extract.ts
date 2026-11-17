import { IssueCode, PipelineIssue } from "../types";

/**
 * Stage 2 — Extraction.
 *
 * Separates the model's *deliverable* from the envelope it sometimes wraps it
 * in: a code fence, or a planning preamble (restated instructions, an outline,
 * chain-of-thought) emitted before the article itself.
 *
 * The rule is structural, not lexical: a document begins at the first line that
 * *starts* with a top-level heading — `<h1 …>` or Markdown `# `. A heading
 * merely mentioned inside prose (for example an instruction that says
 * "start with `<h1>`") never sits at the start of a line, so it can't be
 * mistaken for the real thing. Nothing here pattern-matches on any particular
 * wording, and no content is rewritten — text is only ever cut at a boundary,
 * and whatever was cut is reported as evidence.
 */

/** A line that begins a document: an <h1> element or a Markdown H1. */
const DOCUMENT_START = /^(?:<h1(?:[\s>])|#\s)/i;

/** A dropped preamble longer than this means the model went off-script. */
const LEAKAGE_CHARS = 200;

export interface ExtractResult {
  text: string;
  /** Everything that preceded the document start (usually empty). */
  droppedPrefix: string;
  issues: PipelineIssue[];
}

/** Removes a ``` fence wrapping the entire output (a formatting envelope). */
function unwrapCodeFence(input: string): string {
  const text = input.trim();
  if (!text.startsWith("```")) return text;

  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1) return text;
  // Only a bare opener (``` or ```html) is an envelope; anything else is content.
  if (!/^```[a-z0-9]*$/i.test(text.slice(0, firstBreak).trim())) return text;

  const rest = text.slice(firstBreak + 1);
  const closing = rest.lastIndexOf("```");
  return (closing === -1 ? rest : rest.slice(0, closing)).trim();
}

export function extractDocument(input: string): ExtractResult {
  const issues: PipelineIssue[] = [];
  const unfenced = unwrapCodeFence(input);

  const lines = unfenced.split("\n");
  const startLine = lines.findIndex((line) => DOCUMENT_START.test(line.trimStart()));

  if (startLine === -1) {
    issues.push({
      code: IssueCode.NO_DOCUMENT_START,
      stage: "extract",
      action: "regenerate",
      message:
        "No article start found: the output contains no top-level heading (<h1> or '# ') at the beginning of a line.",
      evidence: unfenced.slice(0, 200),
    });
    return { text: unfenced, droppedPrefix: "", issues };
  }

  const droppedPrefix = lines.slice(0, startLine).join("\n");
  const text = lines.slice(startLine).join("\n").trim();
  const droppedLength = droppedPrefix.trim().length;

  if (droppedLength >= LEAKAGE_CHARS) {
    issues.push({
      code: IssueCode.PROMPT_LEAKAGE,
      stage: "extract",
      action: "review",
      message: `Dropped ${droppedLength} characters of text before the article started — the model emitted a preamble instead of going straight to the article.`,
      evidence: droppedPrefix.trim().slice(0, 200),
    });
  } else if (droppedLength > 0) {
    issues.push({
      code: IssueCode.PROMPT_LEAKAGE,
      stage: "extract",
      action: "warn",
      message: `Dropped a short ${droppedLength}-character preamble before the article.`,
      evidence: droppedPrefix.trim().slice(0, 200),
    });
  }

  return { text, droppedPrefix, issues };
}

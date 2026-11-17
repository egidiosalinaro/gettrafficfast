import { IssueCode, PipelineIssue } from "../types";

/**
 * Stage 1 — Validation.
 *
 * Cheap sanity checks on the raw model output, before we spend any parsing on
 * it. This stage never transforms content: it only trims the envelope and
 * decides whether there is anything worth processing at all.
 */

/** Below this, no model output can plausibly be a 900+ word article. */
export const MIN_RAW_CHARS = 400;

export interface ValidateResult {
  text: string;
  issues: PipelineIssue[];
}

export function validateRawOutput(raw: string): ValidateResult {
  const text = (raw ?? "").trim();
  const issues: PipelineIssue[] = [];

  if (!text) {
    issues.push({
      code: IssueCode.EMPTY_OUTPUT,
      stage: "validate",
      action: "regenerate",
      message: "The model returned an empty response.",
    });
    return { text, issues };
  }

  if (text.length < MIN_RAW_CHARS) {
    issues.push({
      code: IssueCode.OUTPUT_TOO_SHORT,
      stage: "validate",
      action: "regenerate",
      message: `The model returned ${text.length} characters, below the ${MIN_RAW_CHARS} minimum for an article.`,
      evidence: text.slice(0, 200),
    });
  }

  return { text, issues };
}

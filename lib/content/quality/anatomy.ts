import type { CanonicalArticle, IssueAction, IssueCodeValue } from "../types";
import { IssueCode } from "../types";
import {
  SHORT_VERSION_MAX_WORDS,
  anatomyLabels,
  articleDataFacts,
  enoughQuestionHeadings,
  measurementFigures,
  questionHeadings,
  readDataSection,
  readShortVersion,
} from "../anatomy";
import type { GateContext } from "./claims";

/**
 * The article's anatomy as checks (docs/CONTENT_PIPELINE.md, "The article's
 * anatomy"). Detectors only: each names what is missing or wrong, and the
 * one revision is asked to fix it.
 *
 * - `SHORT_VERSION` (warn): the body does not open with the short version,
 *   or it runs over `SHORT_VERSION_MAX_WORDS`.
 * - `QUESTION_HEADINGS` (warn): fewer than half of the section headings are
 *   questions.
 * - `DATA_SECTION`: a "From our data" section where the owner's Facts for
 *   articles hold no figure that may be published (warn), or that states a
 *   weak early figure the rule keeps out (warn), or a figure the owner never
 *   gave (review: a number presented as the site's own data that is not its
 *   data is an invented fact, the one objective problem here).
 *
 * The data checks need to be told the facts (`context.facts`), like the
 * numbers gate: a caller that passes none does not run them.
 */

export interface AnatomyProblem {
  code: IssueCodeValue;
  action: IssueAction;
  message: string;
  evidence?: string;
}

/** Under this a figure in the data section is a count of steps or engines far more often than a claim, unless it is a percentage. */
const MIN_DATA_FIGURE = 10;

export function anatomyProblems(
  article: Pick<CanonicalArticle, "headings" | "language">,
  /** The body as the writer wrote it: without the Read next block. */
  bodyHtml: string,
  context: GateContext
): AnatomyProblem[] {
  const problems: AnatomyProblem[] = [];
  const labels = anatomyLabels(article.language);

  const short = readShortVersion(bodyHtml);
  if (!short) {
    problems.push({
      code: IssueCode.SHORT_VERSION,
      action: "warn",
      message: `The article does not open with the short version: right under the title, one paragraph that starts with "${labels.shortVersion}:" in bold and answers the article's question in 3 to 6 sentences, quotable on its own.`,
    });
  } else if (short.words > SHORT_VERSION_MAX_WORDS) {
    problems.push({
      code: IssueCode.SHORT_VERSION,
      action: "warn",
      message: `The short version is ${short.words} words; it must be 3 to 6 sentences, at most ${SHORT_VERSION_MAX_WORDS} words, with the answer and nothing else.`,
      evidence: short.text.slice(0, 160),
    });
  }

  const headings = questionHeadings(article.headings);
  if (!enoughQuestionHeadings(headings)) {
    problems.push({
      code: IssueCode.QUESTION_HEADINGS,
      action: "warn",
      message: `Only ${headings.questions} of ${headings.counted} section headings are questions; at least half must be the questions readers ask (ending in "?"), each answered in the first one or two sentences of its section. Not questions: ${headings.statements
        .slice(0, 5)
        .map((h) => `"${h}"`)
        .join(", ")}.`,
      evidence: headings.statements.slice(0, 5).join(" | "),
    });
  }

  if (context.facts === undefined) return problems;
  const section = readDataSection(bodyHtml);
  if (!section) return problems;

  const { usable, withheld } = articleDataFacts(context.facts);
  if (usable.length === 0) {
    problems.push({
      code: IssueCode.DATA_SECTION,
      action: "warn",
      message: `The article has a "${section.heading}" section, but the owner's Facts for articles hold no measurement that may be published there${
        withheld.length > 0 ? " (the figures there read as weak early results, which stay off the public blog)" : ""
      }: remove the section.`,
    });
  }

  const same = (a: { value: string; amount: number }, b: { value: string; amount: number }) =>
    a.value === b.value || a.amount === b.amount;
  const usableFigures = usable.flatMap((fact) => fact.figures);
  const weakFigures = withheld.flatMap((fact) => fact.figures);
  const weak: string[] = [];
  const invented: string[] = [];
  for (const figure of measurementFigures(section.text)) {
    if (figure.amount < MIN_DATA_FIGURE && !figure.percent) continue;
    if (usableFigures.some((own) => same(own, figure))) continue;
    if (weakFigures.some((own) => same(own, figure))) weak.push(figure.value);
    else invented.push(figure.value);
  }
  if (invented.length > 0) {
    problems.push({
      code: IssueCode.DATA_SECTION,
      action: "review",
      message: `The "${section.heading}" section states ${invented.length === 1 ? "a figure" : "figures"} (${[...new Set(invented)].join(", ")}) that ${
        invented.length === 1 ? "is" : "are"
      } not in the owner's Facts for articles: a number presented as the site's own data must be one the owner gave. Delete it, or the section.`,
      evidence: section.text.slice(0, 200),
    });
  }
  if (weak.length > 0 && usable.length > 0) {
    problems.push({
      code: IssueCode.DATA_SECTION,
      action: "warn",
      message: `The "${section.heading}" section states ${[...new Set(weak)].join(", ")}, the site's own early traction: weak early results stay off the public blog. Keep only the measurements, or remove the section.`,
      evidence: section.text.slice(0, 200),
    });
  }
  return problems;
}

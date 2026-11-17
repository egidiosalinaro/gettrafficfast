import { z } from "zod";
import { AUDIT_CATEGORIES } from "@/lib/content/quality/blocking";
import { clampText } from "@/lib/content/text";
import { ArticleEvidence, evidenceBlock } from "./article-brief";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * SEO/AEO audit agent.
 *
 * It reads a finished Canonical Article and reports how well it is set up to be
 * *cited* — by Google and by answer engines. It deliberately does not rewrite
 * the body: rewriting validated content reintroduces the risk the content
 * pipeline exists to remove. Its findings feed the quality report, and the
 * metadata it produces (title/description) is used as-is.
 *
 * The criteria come from one premise: an answer engine retrieves a passage, not
 * a page.
 */

export const AeoInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  headings: z.array(z.object({ level: z.number(), text: z.string() })),
  /**
   * The WHOLE body as text. Never a slice: until 2026-11-10 the audit read
   * the first 12,000 characters and then reported "the article text is
   * truncated" as critical on complete articles.
   */
  bodyText: z.string().min(1),
  /** Who publishes it, and the only address of their site: a link elsewhere for them is wrong. */
  businessName: z.string().optional(),
  websiteUrl: z.string().optional(),
  /**
   * The owner's Facts for articles: the author's own verified first-hand
   * data. A figure from here is first-hand and never an E-E-A-T problem
   * (2026-11-12). Never About you, which articles do not read.
   */
  firstHandFacts: z.string().optional(),
  /** The search results the article was written from: what "invented" and "factual error" are judged against. */
  evidence: ArticleEvidence.optional(),
});
export type AeoInput = z.infer<typeof AeoInput>;

/** The categories the model may use; `first_hand` is code's, set after the audit. */
const AuditCategory = z.enum(AUDIT_CATEGORIES);
const MODEL_CATEGORIES = new Set<string>(AUDIT_CATEGORIES.filter((c) => c !== "first_hand"));

export const AeoOutput = z.object({
  /** 0-100. Not a ranking prediction: how retrievable/citable the piece is. */
  score: z.number().min(0).max(100),
  metaTitle: z.string().min(1).max(70),
  metaDescription: z.string().min(1).max(160),
  findings: z
    .array(
      z.object({
        area: z.enum([
          "answerability",
          "chunking",
          "structure",
          "entities",
          "intent",
          "eeat",
          "metadata",
        ]),
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string().min(1),
        /**
         * What kind of problem it is. Only a critical finding in
         * BLOCKING_AUDIT_CATEGORIES holds an article
         * (lib/content/quality/blocking.ts); a stored finding without one
         * reads as `editorial`.
         */
        category: AuditCategory.default("editorial"),
      })
    )
    .max(12)
    .default([]),
  suggestedFaq: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .max(5)
    .default([]),
  entities: z.array(z.string()).max(20).default([]),
});
export type AeoOutput = z.infer<typeof AeoOutput>;

/**
 * What the MODEL is asked for: no hard length or count caps. Models cannot
 * count characters or items reliably (both varieties dead-lettered production
 * jobs), so every maximum is enforced by deterministic clamping below, never
 * by asking.
 */
const LlmAeoOutput = AeoOutput.omit({ findings: true }).extend({
  score: z.number(),
  metaTitle: z.string().min(1),
  metaDescription: z.string().min(1),
  findings: z
    .array(
      z.object({
        area: z.enum([
          "answerability",
          "chunking",
          "structure",
          "entities",
          "intent",
          "eeat",
          "metadata",
        ]),
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string().min(1),
        // A category the model makes up is read as editorial, never a failure.
        category: z.string().optional(),
      })
    )
    .default([]),
  suggestedFaq: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .default([]),
  entities: z.array(z.string()).default([]),
});

/** A search result cuts a title after about this many characters. */
export const META_TITLE_LENGTH = 60;

export const aeoAgent: Agent<AeoInput, AeoOutput> = {
  name: "aeo-audit",
  version: 5,
  inputSchema: AeoInput,
  outputSchema: AeoOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<AeoOutput>> {
    const outline = input.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");

    const own = (input.firstHandFacts ?? "").trim();
    const site = input.websiteUrl?.trim();
    const author = [
      input.businessName ? `Published by: ${input.businessName}` : "",
      site ? `The publisher's only website: ${site}. A link or address for ${input.businessName ?? "the publisher"} on any other host is wrong.` : "",
      own
        ? `The author's own verified first-hand data, in their words (their Facts for articles):\n"""\n${own}\n"""\nA figure or fact that matches this is first-hand, from the author: never an E-E-A-T problem and never critical. The most it earns is an "info" suggestion to state its source and period in the sentence (e.g. "in my own Search Console, Sep–Nov 2026") if the article does not already.`
        : "The author has declared no first-hand data: a result or a number the article presents as the author's own experience is invented.",
    ]
      .filter(Boolean)
      .join("\n");

    const prompt = `You are auditing an article for search engines AND for AI answer engines (ChatGPT, Claude, Gemini, Perplexity).

The premise: an answer engine retrieves a PASSAGE, not a page. A section that only makes sense in the context of the whole article will never be quoted.

Target keyword: ${input.keyword}
Title: ${input.title}

${author}

${evidenceBlock(input.evidence)}

Heading outline:
${outline}

Article text (complete, ${input.bodyText.split(/\s+/).length} words, from the first sentence to the last; it is not truncated):
${input.bodyText}

By design, the article opens with a short-version paragraph (the direct answer, under its label) before the introduction, most section headings are questions, and a "from our data" section, when there is one, states the author's own figures above. None of that is a problem in itself: do not report the short version as repetition.

Audit these areas and report only real problems:
- answerability: does each section answer its implied question in its opening sentences?
- chunking: is each section self-contained, or does it depend on earlier ones ("as we saw above", unresolved pronouns, references to previous sections)?
- structure: is the heading hierarchy coherent and does it match how people ask about this topic?
- entities: are the concepts, products and terms a reader expects actually covered and named explicitly?
- intent: does the article serve the intent behind the keyword?
- eeat: are claims specific and supported, or vague and unverifiable? The author's own first-hand data above is supported by definition.
- metadata: does the title/description pair earn the click and state the answer? Does the body deliver exactly what the title promises (a title that says "ranked", "compared" or "7 ways" needs the ranking, the comparison or the seven)?

Give every finding a category:
- "invented_fact": a fact or number found neither in the search evidence nor in the author's first-hand data above.
- "wrong_link": a link or address that is wrong for who it names, or broken.
- "factual_error": a statement the search evidence or the author's data contradicts.
- "unsafe": content that could harm a reader (dangerous advice, harassment, illegal instructions).
- "editorial": everything else: structure, intent, chunking, authority, style, a title the body does not deliver.

Severity: "critical" only for something that would mislead a reader or make the article unpublishable. Only the first four categories ever hold an article back; an editorial finding is acted on by the editor, so mark it "warning" unless it truly misleads. "warning" for a real weakness a rewrite can fix. "info" for the rest. Do not report formatting you cannot see: you are given plain text, without the markup.

Also produce:
- score: 0-100 for how citable this article is by an answer engine.
- metaTitle: max 60 characters, includes the keyword naturally, promises only what the article delivers. Not the words Mastering, Unlock, Ultimate, Definitive, Blueprint or Unleash.
- metaDescription: max 160 characters, states what the reader gets.
- suggestedFaq: only questions a reader would genuinely still have.
- entities: the key concepts this article actually covers.

Write metaTitle, metaDescription, findings and FAQ in ${input.language}.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmAeoOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    return {
      output: {
        score: Math.max(0, Math.min(100, value.score)),
        metaTitle: clampText(value.metaTitle, META_TITLE_LENGTH),
        metaDescription: clampText(value.metaDescription, 160),
        findings: value.findings.slice(0, 12).map((finding) => ({
          ...finding,
          category: (finding.category && MODEL_CATEGORIES.has(finding.category)
            ? finding.category
            : "editorial") as AeoOutput["findings"][number]["category"],
        })),
        suggestedFaq: value.suggestedFaq.slice(0, 5),
        entities: value.entities.slice(0, 20),
      },
      usage: [usage],
    };
  },
};

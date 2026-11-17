import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Knowledge-extract agent — reads a finished Canonical Article and names what
 * it is about: the entities it covers and the topic cluster it belongs to.
 *
 * This is the write-time half of the knowledge graph. It runs on every
 * generation because retrofitting entities onto hundreds of published articles
 * later costs far more than recording them now. It never touches the article;
 * its output only feeds the graph.
 */

export const ENTITY_TYPES = [
  "product",
  "brand",
  "organization",
  "person",
  "place",
  "technology",
  "concept",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const KnowledgeExtractInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  headings: z.array(z.object({ level: z.number(), text: z.string() })),
  /** Body text, tags stripped — extraction reasons about meaning, not markup. */
  bodyText: z.string().min(1),
  businessNiche: z.string().optional(),
});
export type KnowledgeExtractInput = z.infer<typeof KnowledgeExtractInput>;

export const KnowledgeExtractOutput = z.object({
  entities: z
    .array(
      z.object({
        /** Display form, as the article itself names it. */
        name: z.string().min(1),
        type: z.enum(ENTITY_TYPES),
        /** primary: the article is about it. mentioned: it appears. */
        role: z.enum(["primary", "mentioned"]),
        /** 0-1: how central the entity is to this article. */
        salience: z.number().min(0).max(1),
      })
    )
    .max(20)
    .default([]),
  /** The cluster(s) this article belongs to; exactly one is primary. */
  topics: z
    .array(z.object({ name: z.string().min(1), isPrimary: z.boolean() }))
    .min(1)
    .max(3),
});
export type KnowledgeExtractOutput = z.infer<typeof KnowledgeExtractOutput>;

/**
 * Model-facing schema: minimums stay (quality requirements), maximums and
 * enums-with-consequences are gone. Models cannot count, and an off-list
 * entity type must degrade to "other" at the boundary — never fail the run.
 */
const LlmKnowledgeOutput = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        role: z.string().min(1),
        salience: z.number(),
      })
    )
    .default([]),
  topics: z.array(z.object({ name: z.string().min(1), isPrimary: z.boolean() })).min(1),
});

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

export const knowledgeExtractAgent: Agent<KnowledgeExtractInput, KnowledgeExtractOutput> = {
  name: "knowledge-extract",
  version: 1,
  inputSchema: KnowledgeExtractInput,
  outputSchema: KnowledgeExtractOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<KnowledgeExtractOutput>> {
    const outline = input.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");

    const prompt = `You are building a knowledge graph for a content platform. Read the article below and name what it is ABOUT — not what it merely brushes against.

Target keyword: ${input.keyword}
${input.businessNiche ? `Business niche: ${input.businessNiche}\n` : ""}Title: ${input.title}

Heading outline:
${outline}

Article text:
${input.bodyText.slice(0, 12000)}

Extract:
- entities: the named things the article covers — products, brands, organizations, people, places, technologies, concepts. For each: its name exactly as a knowledgeable reader would call it, a type (product, brand, organization, person, place, technology, concept, other), a role ("primary" if the article is about it, "mentioned" if it merely appears), and a salience from 0 to 1 for how central it is. Only entities genuinely present in the text; never invent.
- topics: the topic cluster(s) this article belongs to, broadest first — the shelf a library would put it on, not a restatement of the title. Mark exactly one topic isPrimary: true. Reuse general, durable topic names: other articles must be able to land on the same topic.

Write entity and topic names in ${input.language}, except proper nouns, which keep their own form.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmKnowledgeOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    // Boundary: unknown types degrade to "other", unknown roles to
    // "mentioned", salience is clamped, duplicates collapse, caps are applied
    // by code. The run never fails over taxonomy taste.
    const seen = new Set<string>();
    const entities: KnowledgeExtractOutput["entities"] = [];
    for (const raw of value.entities) {
      const name = cleanName(raw.name);
      if (!name) continue;
      const type = (ENTITY_TYPE_SET.has(raw.type) ? raw.type : "other") as EntityType;
      const key = `${type}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        name,
        type,
        role: raw.role === "primary" ? "primary" : "mentioned",
        salience: Math.max(0, Math.min(1, raw.salience)),
      });
    }

    const topics = value.topics
      .map((t) => ({ name: cleanName(t.name), isPrimary: t.isPrimary }))
      .filter((t) => t.name.length > 0)
      .slice(0, 3);
    // Exactly one primary, whatever the model marked.
    const primaryIndex = Math.max(0, topics.findIndex((t) => t.isPrimary));
    topics.forEach((t, i) => (t.isPrimary = i === primaryIndex));

    return {
      output: { entities: entities.slice(0, 20), topics },
      usage: [usage],
    };
  },
};

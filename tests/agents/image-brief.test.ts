import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { imageBriefAgent, ImageBriefInput } from "@/lib/agents/image-brief";
import { ALT_MAX_LENGTH } from "@/lib/media/scene-check";

/**
 * The image-brief agent: what it is told, what leaves it, and what it does
 * with a scene the check refuses. The abstract scenes are the ones production
 * rendered (2026-11-10).
 */

const usage = { model: "stub", inputTokens: 50, outputTokens: 100, costUsd: 0.001 };

/** Answers each call with the next plan; the last one repeats. Records every prompt. */
function sequence(plans: unknown[]): { provider: LLMProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      const plan = plans[Math.min(prompts.length, plans.length - 1)];
      prompts.push(prompt);
      return { value: schema.parse(plan), usage, raw: "" };
    },
  };
  return { provider, prompts };
}

const ctx = (): AgentContext => ({
  userId: "user-1",
  articleId: "article-1",
  jobId: "job-1",
  language: "English",
  runId: "run-1",
  budget: createBudget(1),
});

const HEADINGS = [
  { id: "one", level: 2, text: "Section one" },
  { id: "two", level: 2, text: "Section two" },
];

const input = (overrides: Partial<ImageBriefInput> = {}): ImageBriefInput => ({
  keyword: "parcel sorting",
  language: "English",
  title: "How parcel sorting works",
  excerpt: "An intro.",
  headings: HEADINGS,
  sections: {},
  maxInline: 1,
  ...overrides,
});

const HERO = {
  scene: "A conveyor belt in a bright warehouse sorting colourful parcels",
  alt: "Parcels moving along a sorting conveyor",
  caption: null,
};
const INLINE_ONE = {
  scene: "A close-up of a worker holding a cardboard parcel next to a handheld scanner",
  alt: "A worker scanning a parcel",
  caption: "Every parcel gets its own code",
  headingId: "one",
};

const ABSTRACT_HERO = {
  // On topic (it names parcels and sorting), abstract all the same.
  scene:
    "A futuristic, holographic parcel sorting calendar interface with interconnected nodes, projected from a stylized, glowing AI brain",
  alt: "Abstract representation of automated scheduling",
  caption: null,
};

afterEach(() => setLlmProvider(null));

describe("image-brief agent", () => {
  it("returns hero and inline briefs with their slots, and the kind of business", async () => {
    const llm = sequence([{ subject: "physical", hero: HERO, inline: [INLINE_ONE] }]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input(), ctx());

    expect(result.subject).toBe("physical");
    expect(result.hero?.scene).toContain("conveyor");
    expect(result.inline[0].headingId).toBe("one");
    expect(result.rejected).toEqual([]);
    // A clean plan is one call: the second ask is paid for only when needed.
    expect(llm.prompts).toHaveLength(1);
    // The agent must receive the real heading ids to slot against.
    expect(llm.prompts[0]).toContain("[one]");
    expect(llm.prompts[0]).toContain("[two]");
  });

  it("gives the model the section text and the business, not only headings", async () => {
    const llm = sequence([{ subject: "digital", hero: HERO, inline: [] }]);
    setLlmProvider(llm.provider);

    await runAgent(
      imageBriefAgent,
      input({
        sections: { one: "Parcels arrive on pallets and are unloaded by hand before scanning." },
        businessName: "Sortly",
        businessNiche: "Warehouse software",
        businessDescription: "A scheduling tool for parcel depots",
      }),
      ctx()
    );

    const prompt = llm.prompts[0];
    expect(prompt).toContain("Parcels arrive on pallets and are unloaded by hand before scanning.");
    expect(prompt).toContain("Niche: Warehouse software");
    expect(prompt).toContain("What it does: A scheduling tool for parcel depots");
    expect(prompt).toContain('"digital"');
  });

  it("asks once more when a scene is abstract, and takes the rewrite", async () => {
    const llm = sequence([
      { subject: "digital", hero: ABSTRACT_HERO, inline: [INLINE_ONE] },
      {
        subject: "digital",
        hero: {
          scene: "A depot worker sorting parcels by hand into wire cages in the morning, a paper checklist on a clipboard beside her",
          alt: "A depot worker sorting parcels into wire cages",
          caption: null,
        },
        // The retry rewrote the inline scene too; the first one was fine and is kept.
        inline: [{ ...INLINE_ONE, scene: "A different but also acceptable scene of parcels on a shelf" }],
      },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input(), ctx());

    expect(llm.prompts).toHaveLength(2);
    // The second ask says what was wrong, in the check's own words.
    expect(llm.prompts[1]).toContain("YOUR PREVIOUS PLAN WAS REJECTED");
    expect(llm.prompts[1]).toContain("[hero]");
    expect(llm.prompts[1]).toContain("holographic");
    expect(llm.prompts[1]).toContain("AI brain");

    expect(result.hero?.scene).toContain("depot worker");
    expect(result.inline[0].scene).toBe(INLINE_ONE.scene);
    expect(result.rejected).toEqual([]);
  });

  it("drops a scene that is still abstract after the second ask, and says so", async () => {
    const llm = sequence([{ subject: "digital", hero: ABSTRACT_HERO, inline: [INLINE_ONE] }]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input(), ctx());

    // Exactly one retry, never a loop.
    expect(llm.prompts).toHaveLength(2);
    expect(result.hero).toBeNull();
    expect(result.inline.map((i) => i.headingId)).toEqual(["one"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].slot).toBe("hero");
    expect(result.rejected[0].scene).toContain("holographic parcel sorting calendar");
    expect(result.rejected[0].problems).toEqual(expect.arrayContaining(["holographic", "glowing", "calendar"]));
  });

  it("rejects scenes with screens, dashboards or charts in them", async () => {
    const llm = sequence([
      {
        subject: "digital",
        hero: {
          scene: "A depot manager pointing at a large monitor that shows a parcel dashboard full of charts",
          alt: "A depot manager pointing at a monitor",
          caption: null,
        },
        inline: [],
      },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx());

    expect(result.hero).toBeNull();
    expect(result.rejected[0].problems).toEqual(expect.arrayContaining(["screen", "dashboard", "chart"]));
  });

  it("asks again for a hero the model left out, and writes none itself", async () => {
    const llm = sequence([
      { subject: "physical", hero: null, inline: [] },
      { subject: "physical", hero: null, inline: [] },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx());

    expect(llm.prompts).toHaveLength(2);
    // No scene made up from the title: that is the generic picture.
    expect(result.hero).toBeNull();
    expect(result.rejected).toEqual([
      { slot: "hero", scene: "", problems: ["no hero scene was returned"] },
    ]);
  });

  it("discards briefs slotted against unknown headings and caps the count", async () => {
    const llm = sequence([
      {
        hero: HERO,
        inline: [
          { ...INLINE_ONE, headingId: "hallucinated" },
          {
            scene: "A wall of small parcel lockers with one door standing open",
            alt: "Parcel lockers with one open door",
            caption: null,
            headingId: "one",
          },
          {
            scene: "A delivery van driving through a city street at golden hour",
            alt: "A delivery van in the city",
            caption: null,
            headingId: "two",
          },
        ],
      },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 1 }), ctx());

    // The hallucinated slot is gone, the ceiling code passed in is enforced.
    expect(result.inline.map((i) => i.headingId)).toEqual(["one"]);
    // A model that does not say what kind of business it is gets the style as set.
    expect(result.subject).toBe("physical");
  });

  it("plans no in-article image when the ceiling is zero, whatever the model returns", async () => {
    const llm = sequence([{ subject: "physical", hero: HERO, inline: [INLINE_ONE] }]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx());

    expect(result.inline).toEqual([]);
    expect(llm.prompts[0]).toContain("NO in-article images");
  });

  it("never plans two images for the same section", async () => {
    // A paid render for a figure the body would stack on top of another.
    const at = (headingId: string, scene: string) => ({
      scene,
      alt: "A parcel scene in a warehouse",
      caption: null,
      headingId,
    });
    const llm = sequence([
      {
        hero: HERO,
        inline: [
          at("one", "A wall of small parcel lockers with one door open"),
          at("one", "A worker scanning a parcel with a handheld device"),
          at("two", "A delivery van loaded with parcels driving through a city street at dusk"),
        ],
      },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 3 }), ctx());

    expect(result.inline.map((i) => i.headingId)).toEqual(["one", "two"]);
  });

  it("caps alt text at 125 characters", async () => {
    const long =
      "A baker in a white apron sliding a wooden tray of round sourdough loaves into a wood-fired stone oven in a small bakery, early in the morning";
    const llm = sequence([{ subject: "physical", hero: { ...HERO, alt: long }, inline: [] }]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx());

    expect(result.hero?.alt.length).toBeLessThanOrEqual(ALT_MAX_LENGTH);
    expect(result.hero?.alt.startsWith("A baker in a white apron")).toBe(true);
  });

  it("replaces alt text that frames the picture with what the accepted scene contains", async () => {
    const llm = sequence([
      {
        subject: "physical",
        hero: { ...HERO, alt: "An abstract representation of modern logistics" },
        inline: [],
      },
    ]);
    setLlmProvider(llm.provider);

    const result = await runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx());

    expect(result.hero?.alt).toBe("A conveyor belt in a bright warehouse sorting colourful parcels");
    expect(result.hero?.alt).not.toMatch(/representation/i);
  });

  describe("the scene belongs to the article (2026-11-12)", () => {
    const AI_SEO = {
      keyword: "ai seo content writer",
      title: "AI SEO Content Writer: A Workflow From Draft to Clicks",
      businessName: "GetTrafficFast",
      businessNiche: "SEO content software",
    };
    // The hero production rendered for that article.
    const FLORIST = {
      scene: "A florist arranging a bunch of tulips on a wooden counter in a small plant shop, morning light through the window",
      alt: "A florist arranging tulips in a plant shop",
      caption: null,
    };
    const DESK = {
      scene: "A content writer at a desk revising a printed draft, an open laptop beside her, its screen out of focus showing only soft blurred shapes",
      alt: "A writer revising a draft at a desk beside a laptop",
      caption: null,
    };

    it("never gives an AI SEO article a florist: asked again, then the fixed desk scene", async () => {
      const llm = sequence([{ subject: "digital", hero: FLORIST, inline: [] }]);
      setLlmProvider(llm.provider);

      const result = await runAgent(imageBriefAgent, input({ ...AI_SEO, maxInline: 0 }), ctx());

      expect(llm.prompts).toHaveLength(2);
      expect(llm.prompts[1]).toContain("off-topic");
      expect(result.hero?.scene).not.toMatch(/florist|tulip/i);
      expect(result.hero?.scene).toContain("A person working at a desk with an open laptop");
      expect(result.fallbacks).toEqual([expect.objectContaining({ slot: "hero", scene: FLORIST.scene })]);
      expect(result.rejected).toEqual([]);
    });

    it("takes a scene of the article's subject at a laptop whose screen shows nothing legible", async () => {
      const llm = sequence([{ subject: "digital", hero: DESK, inline: [] }]);
      setLlmProvider(llm.provider);

      const result = await runAgent(imageBriefAgent, input({ ...AI_SEO, maxInline: 0 }), ctx());

      expect(llm.prompts).toHaveLength(1);
      expect(result.hero?.scene).toBe(DESK.scene);
    });

    it("tells the model the subject, that a desk and a blurred screen are fine, and that a florist is not", async () => {
      const llm = sequence([{ subject: "digital", hero: DESK, inline: [] }]);
      setLlmProvider(llm.provider);
      await runAgent(imageBriefAgent, input({ ...AI_SEO, maxInline: 0 }), ctx());
      const prompt = llm.prompts[0];
      expect(prompt).toContain('about THIS article\'s subject, "AI SEO Content Writer: A Workflow From Draft to Clicks"');
      expect(prompt).toContain("A florist, a café, a garden");
      expect(prompt).toContain("soft blurred shapes");
      expect(prompt).not.toContain("a shop owner unlocking the door");
    });
  });

  it("rejects a scene that is too short to render meaningfully", async () => {
    const llm = sequence([{ hero: { scene: "Box", alt: "A box on a table", caption: null }, inline: [] }]);
    setLlmProvider(llm.provider);
    await expect(runAgent(imageBriefAgent, input({ maxInline: 0 }), ctx())).rejects.toThrow();
  });
});

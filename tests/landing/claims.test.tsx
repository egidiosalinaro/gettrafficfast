import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Hero } from "@/components/landing/hero";
import { DailyUse } from "@/components/landing/daily-use";
import { AISearch } from "@/components/landing/ai-search";
import { PlanCard, planFeatures } from "@/components/landing/plan-card";
import { engineSentence, toAnswerEngines } from "@/components/landing/engines";

const source = (file: string) =>
  readFileSync(path.resolve(__dirname, "../../components/landing", file), "utf8");

describe("answer engines named on the public pages", () => {
  it("keeps only known engines, in a stable order", () => {
    expect(toAnswerEngines(["perplexity", "chatgpt", "gemini"])).toEqual(["gemini", "perplexity"]);
    expect(toAnswerEngines([])).toEqual([]);
  });

  it("joins the engines into one sentence, or nothing", () => {
    expect(engineSentence(["gemini", "perplexity"])).toBe("Gemini with Google Search and Perplexity");
    expect(engineSentence(["perplexity"])).toBe("Perplexity");
    expect(engineSentence([])).toBe("");
  });

  it("shows a hero chip only for an engine the server asks", () => {
    const html = renderToStaticMarkup(<Hero engines={["gemini"]} />);
    expect(html).toContain("Gemini · sampled");
    expect(html).not.toContain("Perplexity");
    expect(html).not.toContain("when enabled");
  });

  it("does not suggest you can only cancel during the trial", () => {
    const html = renderToStaticMarkup(<Hero engines={[]} />);
    expect(html).toContain("3 days free, card required. Then $69/month,");
    expect(html).toContain("cancel anytime.");
    expect(html).not.toContain("during the trial");
  });

  it("says plainly when no engine is switched on, instead of naming one", () => {
    const daily = renderToStaticMarkup(<DailyUse engines={[]} />);
    const ai = renderToStaticMarkup(<AISearch engines={[]} />);
    expect(daily).not.toContain("Gemini");
    expect(daily).toContain("not measured");
    expect(ai).toContain("No answer engine switched on yet.");
  });
});

describe("the plan card sells what ships", () => {
  it("lists reply drafting", () => {
    expect(planFeatures(["gemini"])).toContain(
      "Reply drafts for posts on X, Reddit and LinkedIn, in your voice. You post them yourself."
    );
  });

  it("names only the engines that are on, and drops the line when none is", () => {
    expect(planFeatures(["gemini"]).join(" ")).not.toContain("Perplexity");
    expect(planFeatures([]).some((f) => f.startsWith("Prompt visibility"))).toBe(false);
  });

  it("does not claim external links, fetched pages or a fixed word count", () => {
    const text = planFeatures(["gemini", "perplexity"]).join(" ");
    expect(text).not.toContain("external");
    expect(text).toContain("900 to 1,500 word brief");
    expect(text).toContain("Autopilot, when you turn it on");
  });

  it("renders the trial terms without limiting cancellation to the trial", () => {
    const html = renderToStaticMarkup(<PlanCard engines={["gemini"]} action={null} />);
    expect(html).toContain("card required");
    expect(html).not.toContain("during the trial");
    expect(html).not.toContain("when enabled");
  });
});

describe("FAQ", () => {
  // The accordion does not render closed answers, so the copy is checked at
  // the source: these sentences described an editor that does not exist.
  it("does not promise an article editor", () => {
    const faq = source("faq.tsx");
    expect(faq).not.toContain("read, edit or drop any article");
    expect(faq).toContain("can&rsquo;t be edited in the app yet");
    expect(faq).not.toContain("collected at signup");
  });

  it("does not say keywords come from competitors or ranking pages are fetched", () => {
    const features = source("features.tsx");
    expect(features).not.toContain("your site and your competitors");
    expect(features).not.toContain("fetched and analysed");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChangeMark,
  EngineRateTiles,
  formatDay,
  formatRate,
  MIN_PROBES_FOR_PERCENT,
  NotMeasured,
  OutcomeBadge,
  parseDay,
  runStatusLabel,
  runTriggerLabel,
  SamplingNotice,
  StatTile,
  TOO_FEW_FOR_PERCENT,
  visibilityHint,
  VisibilityLeadBlock,
} from "@/components/visibility/primitives";
import { engineName } from "@/components/landing/engines";
import { engineLabel } from "@/lib/domain/operating-loop";
import type { VisibilityLead } from "@/lib/visibility/summary";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The pieces every AI Visibility screen is built from. The contract: an
 * unmeasured value is words, never a number; every outcome has a label that
 * says what it means; the sampling notice says what the measurement is not.
 */

describe("visibility primitives", () => {
  it("renders an unmeasured value as words, never as 0", () => {
    expect(renderToStaticMarkup(<NotMeasured />)).toContain("not measured yet");
    expect(formatRate(0, 0)).toBeNull();
    expect(formatRate(0, 3)).toBe("0 of 3");
    expect(formatRate(0, 10)).toBe("0%");
    expect(formatRate(5, 20)).toBe("25%");
  });

  it("has no bare percent helper that would skip the sample threshold", () => {
    const primitives = readFileSync(path.join(root, "components/visibility/primitives.tsx"), "utf8");
    expect(primitives).not.toMatch(/export function percent/);
    for (const file of [
      "components/growth/growth-view.tsx",
      "components/growth/ai-answers.tsx",
      "app/(app)/growth/ai/queries/[id]/page.tsx",
      "components/dashboard/visibility-strip.tsx",
      "components/results/engine-citations.tsx",
      "lib/domain/operating-loop.ts",
    ]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/\bpercent\(|rate \* 100|\.rate \* 100/);
    }
  });

  it("explains a count under a visibility tile, and gives the count behind a percent", () => {
    expect(visibilityHint({ cited: 1, valid: 3, planned: 3 })).toBe(
      `readable answers cited you. ${TOO_FEW_FOR_PERCENT}`
    );
    expect(TOO_FEW_FOR_PERCENT).toContain(String(MIN_PROBES_FOR_PERCENT));
    expect(visibilityHint({ cited: 4, valid: 12, planned: 12, mentioned: 2 }, { mentions: true })).toBe(
      "4 of 12 readable answers cited you · named in 2"
    );
    expect(visibilityHint({ cited: 0, valid: 0, planned: 6 })).toBe("6 probes planned");
  });

  it("labels every probe outcome, keeping unreadable answers apart from not cited", () => {
    expect(renderToStaticMarkup(<OutcomeBadge status="cited" />)).toContain("cited");
    expect(renderToStaticMarkup(<OutcomeBadge status="not_cited" />)).toContain("not cited");
    expect(renderToStaticMarkup(<OutcomeBadge status="invalid" />)).toContain("no valid answer");
    expect(renderToStaticMarkup(<OutcomeBadge status="invalid" />)).toContain("Not counted in the rate");
    expect(renderToStaticMarkup(<OutcomeBadge status="error" />)).toContain("error");
  });

  it("only calls a change a gain or a loss between two readable answers", () => {
    expect(renderToStaticMarkup(<ChangeMark change="gained" previous="not_cited" />)).toContain("gained");
    expect(renderToStaticMarkup(<ChangeMark change="unknown" previous="error" />)).toContain("Not comparable");
    expect(renderToStaticMarkup(<ChangeMark change="new" previous={null} />)).toContain("first probe");
  });

  it("says the measurement is the prompts you set, and leads with the answer", () => {
    const html = renderToStaticMarkup(<SamplingNotice />);
    expect(html).toMatch(/prompts you set/);
    expect(html).toMatch(/Not every AI answer/);
    expect(html).not.toMatch(/border/);

    const lead: VisibilityLead = {
      answer: "Gemini did not cite gettrafficfa.st on any of the 30 prompts it answered.",
      instead: "Cited instead, most often: reddit.com, eesel.ai and hubspot.com.",
      note: "The prompt list changed since the last run, so this is not shown as up or down.",
    };
    const block = renderToStaticMarkup(<VisibilityLeadBlock lead={lead} />);
    expect(block.indexOf("did not cite")).toBeLessThan(block.indexOf("Not every AI answer"));
    expect(block).toContain("reddit.com");
    expect(block).not.toContain("not directly comparable");
  });

  it("renders a tile with its hint", () => {
    const html = renderToStaticMarkup(<StatTile label="Coverage" value="4/6" hint="probes with a readable answer" />);
    expect(html).toContain("Coverage");
    expect(html).toContain("4/6");
    expect(html).toContain("readable answer");
  });
});

describe("formatDay", () => {
  const now = new Date(2026, 10, 9, 12);

  it("reads a day as a person does, in their locale, not as ISO", () => {
    expect(formatDay("2026-11-02", { locale: "en-GB", now })).toBe("2 Nov");
    expect(formatDay("2026-11-02", { locale: "en-US", now })).toBe("Nov 2");
    expect(formatDay("2026-11-02", { now })).not.toContain("2026-11-02");
  });

  it("adds the year only when it is not this year, unless asked", () => {
    expect(formatDay("2025-12-30", { locale: "en-GB", now })).toBe("30 Dec 2025");
    expect(formatDay("2026-11-02", { locale: "en-GB", now, year: "always" })).toBe("2 Nov 2026");
    expect(formatDay("2025-12-30", { locale: "en-GB", now, year: "never" })).toBe("30 Dec");
  });

  it("can lead with the weekday", () => {
    expect(formatDay("2026-11-02", { locale: "en-GB", now, weekday: true })).toBe("Mon 2 Nov");
  });

  it("is in English when no locale is given, never the device's", () => {
    expect(formatDay("2026-11-02", { now })).toBe("Nov 2");
    expect(formatDay("2026-11-02", { now, weekday: true })).toBe("Mon, Nov 2");
    expect(formatDay("2025-12-30", { now })).toBe("Dec 30, 2025");
  });

  it("keeps a bare date on its own day, whatever the timezone", () => {
    const day = parseDay("2026-11-01");
    expect(day?.getFullYear()).toBe(2026);
    expect(day?.getMonth()).toBe(10);
    expect(day?.getDate()).toBe(1);
  });

  it("says nothing it does not know", () => {
    expect(formatDay(null)).toBe("—");
    expect(formatDay("")).toBe("—");
    expect(formatDay("not a date")).toBe("—");
  });
});

describe("EngineRateTiles", () => {
  it("draws one tile per engine, named, never an average", () => {
    const html = renderToStaticMarkup(
      <EngineRateTiles
        label="AI citations"
        rates={[
          { engine: "gemini", rate: 0.2, probes: 10, cited: 2 },
          { engine: "perplexity", rate: 0.5, probes: 12, cited: 6 },
        ]}
      />
    );
    expect(html).toContain("AI citations · Gemini");
    expect(html).toContain("AI citations · Perplexity");
    expect(html).toContain("20%");
    expect(html).toContain("50%");
    expect(html).toContain("cited in 2 of 10 probes");
    // Pooled 36%, mean 35%: neither is shown.
    expect(html).not.toMatch(/3[56]%/);
    expect(html).not.toContain("gemini");
  });

  it("reads an engine with no samples as not measured, never 0%", () => {
    const html = renderToStaticMarkup(
      <EngineRateTiles
        label="AI citations"
        rates={[{ engine: "perplexity", rate: null, probes: 0, cited: 0 }]}
      />
    );
    expect(html).toContain("not measured yet");
    expect(html).not.toContain("0%");
  });

  it("shows a count, not a percent, under 10 probes on an engine", () => {
    const html = renderToStaticMarkup(
      <EngineRateTiles
        label="AI citations"
        rates={[
          { engine: "gemini", rate: 0, probes: 3, cited: 0 },
          { engine: "perplexity", rate: 0.3, probes: 10, cited: 3 },
        ]}
      />
    );
    expect(html).toContain("0 of 3");
    expect(html).toContain("probes cited you, sampled.");
    expect(html).toContain("Too few for a percent (it takes 10).");
    expect(html).not.toContain(">0%<");
    // From the threshold up: the percent, with its count.
    expect(html).toContain("30%");
    expect(html).toContain("cited in 3 of 10 probes");
  });

  it("says not measured, in one tile, when no engine was probed", () => {
    const html = renderToStaticMarkup(<EngineRateTiles label="AI citations" rates={[]} />);
    expect(html).toContain("not measured yet");
    expect(html).toContain("no probes recorded yet");
    expect(html.match(/rounded-lg border/g)).toHaveLength(1);
  });
});

describe("runStatusLabel", () => {
  it("shows a run's status in words, not the stored enum", () => {
    expect(runStatusLabel("completed")).toBe("Done");
    expect(runStatusLabel("running")).toBe("Running");
    expect(runStatusLabel("failed")).toBe("Failed");
  });

  it("says who started a run in words", () => {
    expect(runTriggerLabel("manual")).toBe("By hand");
    expect(runTriggerLabel("schedule")).toBe("Scheduled");
  });

  it("is what Growth and its AI answers show, never the raw status or engine", () => {
    for (const file of ["components/growth/ai-answers.tsx", "components/growth/growth-view.tsx"]) {
      const page = readFileSync(path.join(root, file), "utf8");
      expect(page, file).toContain("engineLabel(");
      expect(page, file).not.toMatch(/\{answer\.engine\}|\{engine\.engine\}<|\{answer\.status\}|engines\.join\(/);
    }
  });
});

describe("engine names", () => {
  it("come from one place: the Overview strip and the landing say Gemini, never gemini", () => {
    const strip = readFileSync(path.join(root, "components/dashboard/visibility-strip.tsx"), "utf8");
    expect(strip).toContain("engineLabel(engine.engine)");
    expect(strip).not.toContain("${engine.engine}");
    expect(engineName("gemini")).toBe(engineLabel("gemini"));
    expect(engineName("perplexity")).toBe(engineLabel("perplexity"));
    const landing = readFileSync(path.join(root, "components/landing/engines.ts"), "utf8");
    expect(landing).not.toMatch(/gemini:\s*"Gemini",/);
  });
});

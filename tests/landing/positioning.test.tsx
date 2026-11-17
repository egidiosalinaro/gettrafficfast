import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DailyUse } from "@/components/landing/daily-use";
import { ProductPreview } from "@/components/landing/product-preview";
import { AISearch } from "@/components/landing/ai-search";
import { appNav } from "@/components/dashboard/nav";

describe("landing positioned as AI search visibility", () => {
  it("shows the product layout as an example, not as a measured result", () => {
    const html = renderToStaticMarkup(<ProductPreview />);
    expect(html).toContain("Example · not a measurement");
    expect(html).toContain("per engine");
    expect(html).toContain("not measured");
    expect(html).not.toMatch(/\d+%/);
  });

  it("describes the working day as prompts, engines, sources, then an action you take", () => {
    const html = renderToStaticMarkup(<DailyUse engines={["gemini", "perplexity"]} />);
    expect(html).toContain("Write the prompts");
    expect(html).toContain("Gemini");
    expect(html).toContain("Perplexity");
    expect(html).toContain("not averaged");
    expect(html).toContain("not measured");
    expect(html).toContain("Nothing is posted");
  });

  it("does not claim engines the platform does not ask", () => {
    const html = renderToStaticMarkup(<AISearch engines={["gemini"]} />);
    expect(html).toContain("ChatGPT, Claude, Copilot and AI Overviews are not asked");
    expect(html).toContain("One rate per engine");
    expect(html).not.toContain("Your Business Mentioned");
  });
});

describe("the app's map", () => {
  it("is four sections: Today, Growth, Content, Settings", () => {
    expect(appNav.map((item) => item.title)).toEqual([
      "Today",
      "Growth",
      "Content",
      "Settings",
    ]);
  });
});

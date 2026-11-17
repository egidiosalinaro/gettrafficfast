import { describe, expect, it } from "vitest";
import {
  ALT_MAX_LENGTH,
  FALLBACK_HERO_SCENE,
  OFF_TOPIC,
  abstractVocabularyIn,
  altIsFraming,
  conceptsOf,
  relevanceProblems,
  sceneProblems,
  sharedConcepts,
  writtenSurfacesIn,
} from "@/lib/media/scene-check";

/**
 * The scene check, against prompts production actually rendered
 * (2026-11-10: 72 of one site's 82 image prompts read like these) and
 * against scenes that must keep passing.
 */

const RENDERED_IN_PRODUCTION = [
  "A futuristic, holographic calendar interface with interconnected nodes, projected from a stylized, glowing AI brain",
  "A stylized, glowing AI brain hovering above a desk, sending data streams into a digital landscape of floating icons",
  "An abstract representation of automated scheduling: luminous lines connecting floating calendar pages in a dark space",
  "A neural network of glowing nodes forming the shape of a rocket, symbolizing growth for a small business",
  "A futuristic dashboard with charts and graphs floating in a digital landscape, representing search visibility",
];

const CONCRETE = [
  "A baker sliding a tray of sourdough loaves into a stone oven in a small bakery at dawn, flour on the wooden counter",
  "A shop owner unlocking the glass door of a small bookshop in the morning, keys in hand, the street still quiet",
  "Two colleagues talking across a wooden desk with notebooks, pens and coffee cups, a closed laptop pushed to one side",
  "A courier loading cardboard parcels into the back of a white van outside a warehouse in soft morning light",
  "A plumber kneeling under a kitchen sink with a wrench, a toolbox open on the tiled floor beside him",
];

describe("abstract vocabulary", () => {
  it("rejects every prompt of the kind production rendered", () => {
    for (const scene of RENDERED_IN_PRODUCTION) {
      expect(sceneProblems(scene), scene).not.toEqual([]);
    }
  });

  it("names what is wrong, for the second ask", () => {
    const problems = abstractVocabularyIn(RENDERED_IN_PRODUCTION[0]);
    expect(problems).toEqual(expect.arrayContaining(["futuristic", "holographic", "glowing", "AI brain", "stylized", "nodes"]));
    expect(abstractVocabularyIn(RENDERED_IN_PRODUCTION[1])).toEqual(
      expect.arrayContaining(["data streams", "digital landscape", "floating elements"])
    );
    expect(abstractVocabularyIn(RENDERED_IN_PRODUCTION[2])).toEqual(
      expect.arrayContaining(["abstract", "representation of"])
    );
    expect(abstractVocabularyIn(RENDERED_IN_PRODUCTION[3])).toEqual(
      expect.arrayContaining(["neural", "representation of"])
    );
  });

  it("accepts scenes a camera could be pointed at", () => {
    for (const scene of CONCRETE) {
      expect(sceneProblems(scene), scene).toEqual([]);
    }
  });

  it("matches whole words, so ordinary words are not caught by a fragment", () => {
    // "ai" inside "waiter", "nodes" inside nothing, "sign" inside "designer".
    expect(sceneProblems("A waiter carrying plates past a designer sketching at a corner table in a cafe")).toEqual([]);
    expect(sceneProblems("A number of volunteers stacking crates of apples in a village hall")).toEqual([]);
  });
});

describe("written surfaces", () => {
  it("rejects screens, dashboards, charts, calendars and signage", () => {
    expect(writtenSurfacesIn("A marketer looking at a laptop screen showing a dashboard")).toEqual(
      expect.arrayContaining(["screen", "dashboard"])
    );
    expect(writtenSurfacesIn("A wall calendar with dates circled in red next to a bar chart")).toEqual(
      expect.arrayContaining(["calendar", "chart"])
    );
    expect(writtenSurfacesIn("A shop front with a large sign above the door and a poster in the window")).toEqual(["signage"]);
    expect(writtenSurfacesIn("A whiteboard covered in handwritten numbers")).toEqual(
      expect.arrayContaining(["signage", "text"])
    );
  });

  it("is part of what makes a scene unacceptable", () => {
    expect(sceneProblems("A team gathered around a monitor in a bright office")).toEqual(["screen"]);
  });

  it("does not reject a laptop that shows nothing", () => {
    expect(sceneProblems("A freelancer at a kitchen table with a closed laptop, a mug and a paper notebook")).toEqual([]);
  });
});

describe("alt text", () => {
  it("is capped at 125 characters", () => {
    expect(ALT_MAX_LENGTH).toBe(125);
  });

  it("flags alt text that says what the picture means instead of what it shows", () => {
    expect(altIsFraming("Abstract representation of automated scheduling")).toBe(true);
    expect(altIsFraming("Image of a bakery")).toBe(true);
    expect(altIsFraming("Rappresentazione astratta della crescita")).toBe(true);
    expect(altIsFraming("A baker sliding loaves into a stone oven")).toBe(false);
    expect(altIsFraming("Un fornaio inforna il pane in un forno a legna")).toBe(false);
  });
});

describe("a digital subject's laptop (2026-11-12)", () => {
  const BLURRED = "A content writer at a desk with an open laptop, its screen out of focus showing only soft abstract shapes";

  it("is allowed when the screen shows nothing legible", () => {
    expect(sceneProblems(BLURRED, "digital")).toEqual([]);
    expect(sceneProblems("A founder at a desk beside a monitor with blurred colour blocks on it", "digital")).toEqual([]);
  });

  it("is still a screen for a physical subject, and a screen that is not said to be blurred is refused", () => {
    expect(sceneProblems(BLURRED, "physical")).toEqual(expect.arrayContaining(["screen"]));
    expect(sceneProblems("A team gathered around a monitor in a bright office", "digital")).toEqual(["screen"]);
  });

  it("never lets legible UI in, blurred or not", () => {
    expect(sceneProblems("A marketer at a laptop whose blurred screen shows a dashboard", "digital")).toEqual(["dashboard"]);
    expect(sceneProblems("An analyst at a desk, the monitor out of focus with a spreadsheet of charts", "digital")).toEqual(
      expect.arrayContaining(["chart"])
    );
    expect(sceneProblems("A writer at a laptop, the screen out of focus, the website open", "digital")).toEqual(["dashboard"]);
  });
});

describe("the scene belongs to the article (2026-11-12)", () => {
  const AI_SEO = { title: "AI SEO Content Writer: A Workflow From Draft to Clicks", keyword: "ai seo content writer" };
  const FLORIST = "A florist arranging a bunch of tulips on a wooden counter in a small plant shop, morning light through the window";

  it("refuses the florist production rendered for an AI SEO article", () => {
    expect(sharedConcepts(FLORIST, AI_SEO)).toEqual([]);
    expect(relevanceProblems(FLORIST, AI_SEO)).toEqual([OFF_TOPIC]);
  });

  it("accepts a scene that shares a concept with the title or keyword, in any form of the word", () => {
    expect(sharedConcepts("A writer revising a printed draft at a kitchen table", AI_SEO)).toEqual(expect.arrayContaining(["writ", "draft"]));
    expect(relevanceProblems("A baker shaping dough on a floured counter", { title: "How to bake sourdough", keyword: "sourdough" })).toEqual([]);
    expect(conceptsOf("Writers writing, baked bakes")).toEqual(new Set(["writ", "bak"]));
  });

  it("accepts the generic desk scene for any article, and the fixed fallback is one", () => {
    expect(relevanceProblems("A person working at a desk with a laptop", AI_SEO)).toEqual([]);
    expect(relevanceProblems(FALLBACK_HERO_SCENE.scene, { title: "How to bake sourdough", keyword: "sourdough" })).toEqual([]);
    for (const subject of ["physical", "digital"] as const) {
      expect(sceneProblems(FALLBACK_HERO_SCENE.scene, subject)).toEqual([]);
    }
  });

  it("reads an inline scene against its section's heading too", () => {
    const article = { title: "How parcel sorting works", keyword: "parcel sorting", heading: "Loading the vans" };
    expect(relevanceProblems("A courier loading a white van outside a warehouse", article)).toEqual([]);
  });
});

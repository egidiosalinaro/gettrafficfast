import { describe, expect, it } from "vitest";
import {
  EMPTY_ONBOARDING_STATUS,
  ONBOARDING_STEPS,
  buildOnboardingStatus,
  nextOnboardingStep,
} from "@/lib/onboarding";

describe("buildOnboardingStatus", () => {
  it("is all false when the account has no site yet", () => {
    expect(
      buildOnboardingStatus({
        hasBusiness: false,
        aboutYou: "I use it to write our weekly posts.",
        imageStyleChosen: true,
        keywordCount: 4,
        articleCount: 2,
        integrationCount: 1,
        manualPostCount: 1,
      })
    ).toEqual(EMPTY_ONBOARDING_STATUS);
  });

  it("has no step to turn Autopilot or images on: both are on by default since 2026-11-24", () => {
    const keys = ONBOARDING_STEPS.map((step) => step.key as string);
    expect(keys).not.toContain("hasAutomation");
    expect(keys).not.toContain("hasImages");
    expect(ONBOARDING_STEPS.map((step) => step.label).join(" ")).not.toMatch(/turn on/i);
  });
});

describe("About you and the first post from X", () => {
  const base = {
    hasBusiness: true,
    aboutYou: "",
    imageStyleChosen: true,
    keywordCount: 0,
    articleCount: 0,
    integrationCount: 0,
    manualPostCount: 0,
  };

  it("counts About you only when it says something", () => {
    expect(buildOnboardingStatus(base).hasAboutYou).toBe(false);
    expect(buildOnboardingStatus({ ...base, aboutYou: "   \n " }).hasAboutYou).toBe(false);
    expect(buildOnboardingStatus({ ...base, aboutYou: "I use it for our blog." }).hasAboutYou).toBe(true);
  });

  it("counts the first post from X once one was added by hand", () => {
    expect(buildOnboardingStatus(base).hasManualPost).toBe(false);
    expect(buildOnboardingStatus({ ...base, manualPostCount: 1 }).hasManualPost).toBe(true);
  });

  it("asks for About you right after the business, before anything else", () => {
    const keys = ONBOARDING_STEPS.map((s) => s.key);
    expect(keys.slice(0, 2)).toEqual(["hasBusiness", "hasAboutYou"]);
    expect(nextOnboardingStep(buildOnboardingStatus(base))?.key).toBe("hasAboutYou");
  });

  it("links each step to the page that does it", () => {
    expect(ONBOARDING_STEPS.find((s) => s.key === "hasAboutYou")).toMatchObject({
      label: "Tell us about you",
      href: "/settings/voice",
    });
    expect(ONBOARDING_STEPS.find((s) => s.key === "hasManualPost")).toMatchObject({
      label: "Add your first post from X",
      href: "/today",
    });
  });

  it("asks for the first post from X once the site is connected", () => {
    const status = buildOnboardingStatus({
      ...base,
      aboutYou: "I use it for our blog.",
      imageStyleChosen: true,
      keywordCount: 3,
      articleCount: 1,
      integrationCount: 1,
    });
    expect(nextOnboardingStep(status)?.key).toBe("hasManualPost");
  });
});

describe("nextOnboardingStep", () => {
  it("starts at the business when nothing is done", () => {
    expect(nextOnboardingStep(EMPTY_ONBOARDING_STATUS)?.key).toBe("hasBusiness");
  });

  it("sends scheduling to the topics, not the calendar", () => {
    const schedule = ONBOARDING_STEPS.find((s) => s.key === "hasArticles");
    expect(schedule?.href).toBe("/content/topics");
  });

  it("is null when every step for the site is done", () => {
    expect(
      nextOnboardingStep({
        hasBusiness: true,
        hasAboutYou: true,
        hasImageStyle: true,
        hasKeywords: true,
        hasArticles: true,
        hasIntegration: true,
        hasManualPost: true,
      })
    ).toBeNull();
  });
});

describe("Choose your image style", () => {
  const base = {
    hasBusiness: true,
    aboutYou: "I use it for our blog.",
    imageStyleChosen: false,
    keywordCount: 0,
    articleCount: 0,
    integrationCount: 0,
    manualPostCount: 0,
  };

  it("is a step until the style is chosen, and done once it is", () => {
    expect(buildOnboardingStatus(base).hasImageStyle).toBe(false);
    expect(buildOnboardingStatus({ ...base, imageStyleChosen: true }).hasImageStyle).toBe(true);
  });

  it("comes right after About you, before the first article can be written", () => {
    const keys = ONBOARDING_STEPS.map((s) => s.key);
    expect(keys.indexOf("hasImageStyle")).toBe(keys.indexOf("hasAboutYou") + 1);
    expect(keys.indexOf("hasImageStyle")).toBeLessThan(keys.indexOf("hasArticles"));
    expect(nextOnboardingStep(buildOnboardingStatus(base))?.key).toBe("hasImageStyle");
  });

  it("asks to choose, never to turn something on, and links to the images settings", () => {
    const step = ONBOARDING_STEPS.find((s) => s.key === "hasImageStyle");
    expect(step).toMatchObject({ label: "Choose your image style", href: "/settings/automation#images" });
    expect(step?.description).toMatch(/featured image once you pick a style/);
    expect(step?.description).toMatch(/without images/);
  });

  it("is still asked on a site that has everything else", () => {
    const status = buildOnboardingStatus({ ...base, keywordCount: 3, articleCount: 2, integrationCount: 1, manualPostCount: 1 });
    expect(nextOnboardingStep(status)?.key).toBe("hasImageStyle");
  });
});

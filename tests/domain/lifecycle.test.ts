import { describe, expect, it } from "vitest";
import {
  ARTICLE_STATES,
  canStartProduction,
  canTransition,
  isArticleState,
} from "@/lib/domain/lifecycle";

describe("article lifecycle", () => {
  it("allows the normal production path", () => {
    expect(canTransition("queued", "generating")).toBe(true);
    expect(canTransition("generating", "generated")).toBe(true);
    expect(canTransition("generated", "published")).toBe(true);
  });

  it("allows the quality gate to divert to review from either side", () => {
    expect(canTransition("generating", "needs_review")).toBe(true);
    expect(canTransition("generated", "needs_review")).toBe(true);
    // Human approval publishes it; regeneration sends it back.
    expect(canTransition("needs_review", "published")).toBe(true);
    expect(canTransition("needs_review", "generating")).toBe(true);
    expect(canTransition("needs_review", "generated")).toBe(true);
  });

  it("allows a published article to be regenerated and republished", () => {
    expect(canTransition("published", "generating")).toBe(true);
    expect(canTransition("published", "published")).toBe(true);
  });

  it("lets Generate now / Regenerate start production from every resting state", () => {
    expect(canStartProduction("queued")).toBe(true);
    expect(canStartProduction("generated")).toBe(true);
    expect(canStartProduction("published")).toBe(true);
    expect(canStartProduction("needs_review")).toBe(true);
    expect(canStartProduction("failed")).toBe(true);
    expect(canStartProduction("generating")).toBe(false);
  });

  it("allows a dead-lettered article to be revived", () => {
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("failed", "generating")).toBe(true);
  });

  it("refuses transitions that skip production", () => {
    expect(canTransition("queued", "published")).toBe(false);
    expect(canTransition("queued", "generated")).toBe(false);
    expect(canTransition("queued", "needs_review")).toBe(false);
  });

  it("refuses to move out of a state into itself except for republishing", () => {
    for (const state of ARTICLE_STATES) {
      if (state === "published") continue;
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it("recognises only known states", () => {
    expect(isArticleState("generated")).toBe(true);
    expect(isArticleState("archived")).toBe(false);
    expect(isArticleState(42)).toBe(false);
  });
});

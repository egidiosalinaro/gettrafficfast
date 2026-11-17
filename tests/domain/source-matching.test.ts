import { describe, expect, it } from "vitest";
import { findMention, isCompanySource, type NamedEntity } from "@/lib/domain/source-matching";

/**
 * The primitives every "is this ours?" judgement rests on. It must never
 * claim a company was cited when it wasn't, and never quietly turn a
 * coincidental word match into a confident mention. Every case below is a
 * way that could happen.
 */

const company = (over: Partial<NamedEntity> = {}): NamedEntity => ({ name: "Acme", ...over });

describe("isCompanySource", () => {
  it("matches the exact host", () => {
    expect(isCompanySource("acme.test", "acme.test")).toBe(true);
  });

  it("matches a subdomain, because a blog is still the company's site", () => {
    expect(isCompanySource("blog.acme.test", "acme.test")).toBe(true);
    expect(isCompanySource("docs.eu.acme.test", "acme.test")).toBe(true);
  });

  it("ignores www. and case on both sides", () => {
    expect(isCompanySource("WWW.Acme.test", "acme.test")).toBe(true);
  });

  it("does not match a domain that merely ends with the same letters", () => {
    expect(isCompanySource("notacme.test", "acme.test")).toBe(false);
    expect(isCompanySource("fakeacme.test", "acme.test")).toBe(false);
  });

  it("does not match the company as a subdomain of someone else", () => {
    expect(isCompanySource("acme.test.evil.com", "acme.test")).toBe(false);
  });

  it("is false when either side is empty", () => {
    expect(isCompanySource("", "acme.test")).toBe(false);
    expect(isCompanySource("acme.test", "")).toBe(false);
  });
});

describe("findMention", () => {
  it("finds a whole-word name", () => {
    expect(findMention("I recommend Acme for this.", company())).toEqual({
      mentioned: true,
      ambiguous: false,
    });
  });

  it("does not match a name inside a longer word", () => {
    expect(findMention("Acmex is unrelated.", company()).mentioned).toBe(false);
  });

  it("matches around punctuation", () => {
    expect(findMention("Try Acme, or something else.", company()).mentioned).toBe(true);
  });

  it("flags a name that is an ordinary word as ambiguous", () => {
    expect(findMention("Draw a linear regression.", company({ name: "Linear" }))).toEqual({
      mentioned: true,
      ambiguous: true,
    });
  });

  it("flags a very short name as ambiguous", () => {
    expect(findMention("The arc of the story.", company({ name: "Arc" })).ambiguous).toBe(true);
  });

  it("clears the ambiguity when an unambiguous alias also matched", () => {
    const c = company({ name: "Bolt", aliases: ["Bolt Analytics"] });
    expect(findMention("Bolt Analytics, also known as Bolt, is fast.", c)).toEqual({
      mentioned: true,
      ambiguous: false,
    });
  });

  it("treats a multi-word name as specific enough", () => {
    expect(findMention("Wave Accounting is an option.", company({ name: "Wave Accounting" })).ambiguous).toBe(false);
  });

  it("does not blow up on regex characters in a name", () => {
    expect(() => findMention("Anything.", company({ name: "C++ Tools" }))).not.toThrow();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CITED_PLACES_HREF, PlacesLine } from "@/components/visibility/places-line";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Growth → AI answers' one line about the places the answers led to, now
 * that each run sends its cited pages to Today by itself: how many are open
 * there, linked; with the setting off, where to turn it on; otherwise
 * nothing, never a "0". No screen has a button that did it by hand (the
 * tool and the route stay).
 */

const html = (props: Parameters<typeof PlacesLine>[0]) => renderToStaticMarkup(<PlacesLine {...props} />);

describe("the places line", () => {
  it("counts the open places in Today and links to them", () => {
    const three = html({ placesFromSources: true, count: 3 });
    expect(three).toContain("3 pages the answers cited are in Today, as places to reply.");
    expect(three).toContain(`href="${CITED_PLACES_HREF}"`);
    expect(three).toContain("Open them");
    expect(CITED_PLACES_HREF).toBe("/today?source=ai_visibility");

    expect(html({ placesFromSources: true, count: 1 })).toContain("1 page the answers cited is in Today, as a place to reply.");
  });

  it("points to Configure when the setting is off", () => {
    const off = html({ placesFromSources: false, count: 0 });
    expect(off).toContain("Cited pages are not sent to Today.");
    expect(off).toContain('href="/growth/ai/settings#places"');
    // Places sent earlier, or by hand, are still said, even with it off.
    expect(html({ placesFromSources: false, count: 2 })).toContain("2 pages the answers cited are in Today");
  });

  it("says nothing when none is open or the count could not be read", () => {
    expect(html({ placesFromSources: true, count: 0 })).toBe("");
    expect(html({ placesFromSources: true, count: null })).toBe("");
  });

  it("sits in Growth's AI block, and no screen has a button for it", () => {
    const view = readFileSync(path.join(root, "components/growth/growth-view.tsx"), "utf8");
    const answers = readFileSync(path.join(root, "components/growth/ai-answers.tsx"), "utf8");
    expect(view).toContain("<PlacesLine");
    for (const text of [view, answers]) {
      expect(text).not.toContain("Find places from the last run");
      expect(text).not.toContain("/api/visibility/places");
    }
  });
});

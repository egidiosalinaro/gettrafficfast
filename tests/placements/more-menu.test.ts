import { describe, expect, it } from "vitest";
import { menuPlace } from "@/components/placements/ui";

/**
 * Regression: the ⋯ menu was `absolute` under its button, inside a pane that
 * scrolls, so near the bottom its last lines were cut off by the pane's
 * edge. It is placed against the screen now, on the side where it fits.
 */
describe("menuPlace", () => {
  const screen = { width: 1280, height: 800 };

  it("opens below the button when its lines fit there", () => {
    const place = menuPlace({ top: 100, bottom: 132, right: 1000 }, 5, screen.width, screen.height);
    expect(place).toEqual({ right: 280, top: 136, maxHeight: 656 });
  });

  it("opens above when there is no room below and there is above", () => {
    const place = menuPlace({ top: 700, bottom: 732, right: 1000 }, 5, screen.width, screen.height);
    expect(place.top).toBeUndefined();
    expect(place.bottom).toBe(104); // 800 - 700 + 4: its bottom edge sits just over the button
    expect(place.maxHeight).toBe(688);
  });

  it("takes the roomier side and scrolls inside it when it fits on neither", () => {
    const place = menuPlace({ top: 120, bottom: 152, right: 300 }, 12, 390, 300);
    expect(place.top).toBe(156);
    expect(place.maxHeight).toBe(136);
  });

  it("never leaves the screen on the right", () => {
    expect(menuPlace({ top: 10, bottom: 42, right: 388 }, 3, 390, 844).right).toBe(8);
  });
});

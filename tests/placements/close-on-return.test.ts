import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOnReturn, isHomeScreenApp } from "@/components/placements/reply-logic";

/**
 * Regression, 2026-11-12: in the home-screen app, Reply on X left a blank
 * in-app browser sheet over GetTrafficFast after the X app took the link.
 */
type Listener = () => void;
function fakeEnv(standalone: boolean) {
  const listeners = new Map<string, Listener[]>();
  const on = (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const off = (type: string, fn: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
  const doc = { visibilityState: "hidden", addEventListener: on, removeEventListener: off };
  const win = { addEventListener: on, removeEventListener: off, matchMedia: () => ({ matches: false }) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { standalone });
  return {
    doc,
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

describe("closeOnReturn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes the sheet the first time the home-screen app is seen again", () => {
    const env = fakeEnv(true);
    const opened = { closed: false, close: vi.fn() };
    expect(isHomeScreenApp()).toBe(true);
    closeOnReturn(opened as unknown as Window);
    vi.advanceTimersByTime(600);
    env.fire("visibilitychange"); // still hidden: the person is on X
    expect(opened.close).not.toHaveBeenCalled();
    env.doc.visibilityState = "visible";
    env.fire("visibilitychange");
    expect(opened.close).toHaveBeenCalledTimes(1);
    env.fire("focus");
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  it("leaves the X tab alone in a normal browser", () => {
    const env = fakeEnv(false);
    const opened = { closed: false, close: vi.fn() };
    closeOnReturn(opened as unknown as Window);
    vi.advanceTimersByTime(600);
    env.doc.visibilityState = "visible";
    env.fire("visibilitychange");
    expect(opened.close).not.toHaveBeenCalled();
  });
});

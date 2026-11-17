import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Article, ArticleStatus } from "@/components/dashboard/article-card";
import { Calendar, WEEKDAY_NAMES } from "@/components/dashboard/calendar";
import { dayKey } from "@/components/dashboard/calendar-model";

/**
 * The Articles board on a phone and on a desktop, from the markup. Below
 * `md` it is a list of full-width cards; the 7-column grid, and the drag
 * that comes with it, exist only from `md` up, and nothing on a phone may
 * set `touch-action: none` (it blocked scrolling on queued cards).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

function inDays(offset: number): string {
  const now = new Date();
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

function article(id: string, status: ArticleStatus, offset: number, keyword: string): Article {
  return { id, keyword, status, scheduledDate: inDays(offset), searchVolume: 1200 };
}

const LONG_TITLE = "how to choose a running shoe for flat feet";

const articles: Article[] = [
  article("q1", "queued", 2, LONG_TITLE),
  article("f1", "failed", 4, "failed keyword"),
  article("p1", "published", -3, "published keyword"),
  article("p-old", "published", -90, "published long ago"),
];

function render(list = articles) {
  return renderToStaticMarkup(
    <Calendar
      articles={list}
      onRemoveArticle={() => {}}
      onViewArticle={() => {}}
      onRequeueArticle={() => {}}
      onMoveArticle={() => {}}
      onGenerateNow={() => {}}
    />
  );
}

/** The markup of the element carrying `data-view="<view>"`, up to the next view. */
function view(html: string, name: "list" | "grid"): string {
  const start = html.indexOf(`data-view="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const other = html.indexOf(`data-view="${name === "list" ? "grid" : "list"}"`, start);
  return html.slice(start, other === -1 ? undefined : other);
}

describe("Calendar on a phone", () => {
  it("renders a list below md and the grid only from md up", () => {
    const html = render();
    expect(html).toMatch(/class="md:hidden[^"]*" data-view="list"/);
    expect(html).toMatch(/class="hidden md:block[^"]*" data-view="grid"/);
  });

  it("lists upcoming work first, then recent publications, with whole titles and dates", () => {
    const list = view(render(), "list");
    expect(list.indexOf("Coming up")).toBeGreaterThan(-1);
    expect(list.indexOf("Coming up")).toBeLessThan(list.indexOf("Published, last 30 days"));
    expect(list.indexOf(LONG_TITLE)).toBeLessThan(list.indexOf("failed keyword"));
    expect(list.indexOf("failed keyword")).toBeLessThan(list.indexOf("published keyword"));
    // The full title, a status, a date line, and the card's actions.
    expect(list).toContain(LONG_TITLE);
    expect(list).toContain("Queued");
    expect(list).toMatch(/Scheduled for /);
    expect(list).toMatch(/Published [^<]/);
    expect(list).toContain("Generate now");
    expect(list).toContain("Re-queue");
    // Published more than 30 days ago: on Results, not on the board.
    expect(list).not.toContain("published long ago");
  });

  it("claims no touch gesture on a phone", () => {
    const html = render();
    expect(html).not.toMatch(/touch-action/);
    const list = view(html, "list");
    expect(list).not.toMatch(/touch-none/);
    expect(list).not.toMatch(/cursor-grab/);
    // In the grid the drag handle exists, but only from md up.
    const grid = view(html, "grid");
    expect(grid).toMatch(/md:touch-none/);
    expect(grid).not.toMatch(/(?<!md:)touch-none/);
  });

  it("gives every card action a 44px target below md", () => {
    const list = view(render(), "list");
    const actions = list.match(/<button[^>]*>/g) ?? [];
    expect(actions.length).toBeGreaterThan(0);
    for (const button of actions) expect(button).toMatch(/min-h-11|h-11/);
  });
});

describe("Calendar grid", () => {
  it("names weekdays in English only", () => {
    const grid = view(render(), "grid");
    for (const day of WEEKDAY_NAMES) expect(grid).toContain(`>${day}<`);
    for (const italian of ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]) {
      expect(grid).not.toContain(`>${italian}<`);
    }
  });

  it("counts one article as one article", () => {
    const html = render([article("only", "queued", 0, "only one")]);
    expect(html).toContain("1 article this month");
    expect(html).not.toContain("1 articles");
  });

  it("keeps content text at 12px or more", () => {
    for (const file of [
      "components/dashboard/calendar.tsx",
      "components/dashboard/article-card.tsx",
      "components/dashboard/article-modal.tsx",
    ]) {
      expect(source(file)).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    }
  });
});

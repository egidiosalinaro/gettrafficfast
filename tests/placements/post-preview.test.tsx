import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_TONE_COUNT, authorAvatar, authorHandle, avatarTone, businessAvatar, initialsOf } from "@/lib/placements/avatar";
import { AVATAR_PROXY_BASE, publicAvatarUrl } from "@/lib/providers/avatars/public";
import { AVATAR_TONES, AuthorAvatar, BusinessAvatar, PostHeader } from "@/components/placements/post-preview";
import { LinkSheet, linkHint, linkSheetToast, saveTypedLink } from "@/components/placements/link-sheet";
import { QueueRow } from "@/components/placements/queue";
import { ReplyItem, type ReplyItemProps } from "@/components/placements/reply-item";
import { PostedItem } from "@/components/placements/posted-item";
import { postMeta, shortcutFor } from "@/components/placements/reply-logic";
import { BusyLabel, CHIP, MoreMenu } from "@/components/placements/ui";
import { Toast } from "@/components/placements/toast";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";

/**
 * The Replies item as a post and the reply under it (2026-11-10): the
 * author's picture, the business's icon, loaders on every button that
 * waits on a request, and the link sheet after I posted it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const NOW = Date.parse("2026-11-10T09:30:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const noop = () => {};

const draft = (over: Partial<PlacementDraftRecord> = {}): PlacementDraftRecord => ({
  id: "d-1",
  variant: "short_comment",
  body: "Answer engines retrieve passages, not pages.",
  linkUrl: null,
  claims: [],
  audit: { status: "passed", checks: [{ id: "answers_first", label: "Answers first", status: "pass", detail: "ok" }] },
  auditStatus: "passed",
  agentVersion: 1,
  updatedAt: ago(1),
  ...over,
});

const target = (over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord => ({
  id: "t-1",
  surface: "x",
  kind: "post",
  url: "https://x.com/maya_builds/status/1900000000000000001",
  title: "Zero mentions for the 20 prompts our customers type.",
  excerpt: "Zero mentions for the 20 prompts our customers type.",
  community: "@maya_builds",
  author: "maya_builds",
  postedAt: ago(3),
  postedAtPrecision: null,
  score: null,
  commentCount: null,
  foundFor: null,
  foundVia: "manual",
  status: "drafted",
  qualifyScore: null,
  qualifyReason: null,
  qualifyAngle: null,
  qualifiedBy: "person",
  qualifiedAt: ago(2),
  topic: null,
  intent: null,
  freshUntil: null,
  snoozedUntil: null,
  reviewNote: null,
  dismissedReason: null,
  publishedUrl: null,
  publishedAt: null,
  publishedNote: null,
  aeoQueryId: null,
  selectedPlacementId: null,
  lastSeenAt: ago(1),
  createdAt: ago(2),
  drafts: [draft()],
  ...over,
});

const saved = async () => ({ ok: false as const, error: "not in a test" });
const item = (t: PlacementTargetRecord, over: Partial<ReplyItemProps> = {}) =>
  renderToStaticMarkup(
    <ReplyItem
      target={t}
      now={NOW}
      business={{ name: "GetTrafficFast", domain: "gettrafficfa.st" }}
      busy={false}
      replied={false}
      onRepliedChange={noop}
      onDraft={noop}
      onAction={noop}
      onMarkPublished={async () => null}
      onSaveDraft={saved}
      onSaveOwnReply={saved}
      onCorrectDraft={saved}
      onPromoteNote={saved}
      {...over}
    />
  );
/** The attribute, not the `disabled:opacity-50` class. */
const DISABLED = 'disabled=""';
const imgs = (html: string) => [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
/** The `<button>` whose visible text is `label`, with its attributes. */
const buttonOf = (html: string, label: string) =>
  [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>)[^])*)<\/button>/g)].find((m) => m[2].replace(/<[^>]+>/g, "").trim() === label);

describe("the author's picture", () => {
  it("reads the handle from the author, or from an X community, and never from a deleted account", () => {
    expect(authorHandle({ surface: "x", author: "maya_builds", community: "@maya_builds" })).toBe("maya_builds");
    expect(authorHandle({ surface: "x", author: null, community: "@maya_builds" })).toBe("maya_builds");
    expect(authorHandle({ surface: "reddit", author: "u/organic_ops", community: "r/SEO" })).toBe("organic_ops");
    expect(authorHandle({ surface: "reddit", author: "[deleted]", community: "r/SEO" })).toBeNull();
    expect(authorHandle({ surface: "quora", author: null, community: "Quora" })).toBeNull();
    // A community is a handle on X only.
    expect(authorHandle({ surface: "reddit", author: null, community: "r/SEO" })).toBeNull();
  });

  it("makes initials from the first two words, or the first letter of one", () => {
    expect(initialsOf("Anna Keller")).toBe("AK");
    expect(initialsOf("anna-keller")).toBe("AK");
    expect(initialsOf("maya_builds")).toBe("MB");
    expect(initialsOf("growthnotes")).toBe("G");
    expect(initialsOf("@pg_fan_42")).toBe("PF");
    expect(initialsOf("u/throwaway_sdk_dev")).toBe("TS");
    expect(initialsOf("")).toBe("");
    expect(initialsOf("1234")).toBe("");
  });

  it("gives a handle the same colour every time, whatever its case, among the palette's", () => {
    expect(avatarTone("maya_builds")).toBe(avatarTone("maya_builds"));
    expect(avatarTone("Maya_Builds")).toBe(avatarTone("maya_builds"));
    const tones = new Set(["a", "b", "maya_builds", "seo_contrarian", "anna-keller", "organic_ops", "x", "y", "z"].map(avatarTone));
    for (const tone of tones) {
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(AVATAR_TONE_COUNT);
    }
    expect(tones.size).toBeGreaterThan(1);
    expect(AVATAR_TONES).toHaveLength(AVATAR_TONE_COUNT);
    // Every colour has its dark-mode variant.
    for (const tone of AVATAR_TONES) expect(tone).toMatch(/dark:bg-\S+ dark:text-\S+/);
  });

  it("tries a stored picture, then the public one by handle, then initials, then the platform's mark", () => {
    const stored = authorAvatar({ surface: "x", author: "maya_builds", community: "@maya_builds", storedUrl: "https://pbs.example/maya.jpg" });
    expect(stored.images).toEqual(["https://pbs.example/maya.jpg", `${AVATAR_PROXY_BASE}/x/maya_builds?fallback=false`]);
    expect(stored.initials).toBe("MB");
    // An http (not https) stored value is not shown.
    expect(authorAvatar({ surface: "x", author: "maya_builds", community: null, storedUrl: "http://pbs.example/m.jpg" }).images).toEqual([
      `${AVATAR_PROXY_BASE}/x/maya_builds?fallback=false`,
    ]);
    // LinkedIn has no public picture by handle: initials.
    const li = authorAvatar({ surface: "linkedin", author: "Anna Keller", community: null });
    expect(li.images).toEqual([]);
    expect(li.initials).toBe("AK");
    expect(li.name).toBe("Anna Keller");
    // No author: the platform's mark, no picture, no letters.
    const quora = authorAvatar({ surface: "quora", author: null, community: "Quora" });
    expect(quora).toMatchObject({ handle: null, images: [], initials: "", name: "Quora", mark: "quora.com" });
  });

  it("asks the platform itself where it has a public picture, the proxy where it has none, and nobody elsewhere", () => {
    expect(publicAvatarUrl("github", "mkrause")).toBe("https://github.com/mkrause.png?size=80");
    expect(publicAvatarUrl("x", "maya_builds")).toBe(`${AVATAR_PROXY_BASE}/x/maya_builds?fallback=false`);
    expect(publicAvatarUrl("reddit", "organic_ops")).toBe(`${AVATAR_PROXY_BASE}/reddit/organic_ops?fallback=false`);
    for (const surface of ["linkedin", "hackernews", "quora", "devto", "web"]) expect(publicAvatarUrl(surface, "someone")).toBeNull();
    // Not a handle the platform would accept: no lookup.
    expect(publicAvatarUrl("x", "Anna Keller")).toBeNull();
    expect(publicAvatarUrl("x", "much_too_long_for_x_handles")).toBeNull();
    expect(publicAvatarUrl("x", "")).toBeNull();
    expect(publicAvatarUrl("x", null)).toBeNull();
  });

  it("is the one place an avatar host is named", () => {
    for (const file of [
      "lib/placements/avatar.ts",
      "components/placements/post-preview.tsx",
      "components/placements/reply-item.tsx",
      "components/placements/queue.tsx",
    ]) {
      expect(source(file)).not.toContain("unavatar");
    }
  });

  it("shows no image without a handle, and draws the initials under a picture that loads lazily without a referrer", () => {
    const none = renderToStaticMarkup(<AuthorAvatar target={{ surface: "reddit", author: null, community: "r/SEO" }} />);
    expect(imgs(none).filter((src) => !src.includes("s2/favicons"))).toEqual([]);
    expect(none).toContain('data-avatar="mark"');
    expect(none).toContain("domain=reddit.com");

    const html = renderToStaticMarkup(<AuthorAvatar target={{ surface: "x", author: "maya_builds", community: "@maya_builds" }} />);
    expect(imgs(html)).toEqual([`${AVATAR_PROXY_BASE}/x/maya_builds?fallback=false`]);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('alt=""');
    // The initials are there under the picture: nothing waits on it.
    expect(html).toContain(">MB<");

    const initials = renderToStaticMarkup(<AuthorAvatar target={{ surface: "linkedin", author: "anna-keller", community: "linkedin" }} />);
    expect(imgs(initials)).toEqual([]);
    expect(initials).toContain('data-avatar="initials"');
    expect(initials).toContain(">AK<");
  });
});

describe("the business beside the draft", () => {
  it("is the business's favicon and name, else its initials, else You", () => {
    expect(businessAvatar({ name: "GetTrafficFast", domain: "gettrafficfa.st" })).toMatchObject({ name: "GetTrafficFast", domain: "gettrafficfa.st", initials: "G" });
    expect(businessAvatar({ name: null, domain: "gettrafficfa.st" }).name).toBe("gettrafficfa.st");
    expect(businessAvatar(null)).toMatchObject({ name: "You", domain: null, initials: "Y" });
    const html = renderToStaticMarkup(<BusinessAvatar business={{ name: "Acme Tools", domain: "acme.dev" }} />);
    expect(html).toContain('data-avatar="business"');
    expect(html).toContain("domain=acme.dev");
    const none = renderToStaticMarkup(<BusinessAvatar business={{ name: "Acme Tools", domain: null }} />);
    expect(none).toContain(">AT<");
    expect(imgs(none)).toEqual([]);
  });

  it("makes the open item a thread: the post with its author, a line, the draft with the business", () => {
    const html = item(target());
    expect(html).toContain("data-thread-line");
    expect(html.indexOf("@maya_builds")).toBeLessThan(html.indexOf("GetTrafficFast"));
    expect(html.indexOf("GetTrafficFast")).toBeLessThan(html.indexOf("<textarea"));
    expect(html).toContain("domain=gettrafficfa.st");
    // The draft is still the largest text, and still the field with its faint ground.
    expect(html).toMatch(/<textarea[^>]*text-\[17px\][^>]*hover:bg-foreground\/\[0\.03\]/);
  });

  it("shows no thread line on an item with no reply under it yet", () => {
    const html = item(target({ drafts: [], status: "qualified" }));
    expect(html).not.toContain("data-thread-line");
    expect(html).not.toContain("GetTrafficFast");
    expect(html).toContain("Draft it");
  });

  it("does the same on a posted item: the post, then your reply beside the business", () => {
    const html = renderToStaticMarkup(
      <PostedItem
        target={target({ status: "published_manually", publishedAt: ago(1), selectedPlacementId: "d-1" })}
        now={NOW}
        business={{ name: "GetTrafficFast", domain: "gettrafficfa.st" }}
        aeoQueries={[]}
        busy={false}
        onSetPublishedUrl={async () => null}
      />
    );
    expect(html).toContain("data-thread-line");
    expect(html.indexOf("@maya_builds")).toBeLessThan(html.indexOf("GetTrafficFast"));
    expect(html.indexOf("GetTrafficFast")).toBeLessThan(html.indexOf("Answer engines retrieve passages"));
  });

  it("says who once: the name above, the platform, the community and the age under it", () => {
    expect(postMeta(target(), NOW)).toBe("X · posted 3h ago");
    expect(postMeta(target({ surface: "reddit", author: "organic_ops", community: "r/SEO", commentCount: 12 }), NOW)).toBe("Reddit · r/SEO · posted 3h ago · 12 comments");
    // No date from the source: said, not left blank (2026-11-12).
    expect(postMeta(target({ surface: "quora", author: null, community: "Quora", postedAt: null }), NOW)).toBe("date unknown");
    // A posted item gives the post's age, not "posted 1h": that is the reply's.
    expect(postMeta(target({ status: "published_manually", publishedAt: ago(1) }), NOW)).toBe("X · 3h");
    const html = renderToStaticMarkup(<PostHeader target={target()} now={NOW} end={<a href="#">Open post</a>} />);
    expect(html).toContain("@maya_builds");
    expect(html).toContain("X · posted 3h ago");
  });
});

describe("a closed row with the author's picture", () => {
  it("keeps the row's height: a 24px picture in the dot's place, the state's dot on its corner, the word at the right", () => {
    const html = renderToStaticMarkup(<QueueRow target={target()} now={NOW} onOpen={noop} />);
    // The row's own height is unchanged: the tap target, and no taller picture.
    expect(html).toContain("min-h-14");
    expect(html).toContain("width:24px;height:24px");
    expect(html).not.toMatch(/width:(2[5-9]|[3-9]\d)px/);
    expect(html).toContain('data-tone="ready"');
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain("Draft ready");
    expect(html).toContain("X · @maya_builds · 3h");
  });
});

describe("loaders on the buttons that wait on a request", () => {
  it("keeps the label in place, faded, with a spinner over it: same size, nothing jumps", () => {
    const idle = renderToStaticMarkup(<button className={CHIP}><BusyLabel busy={false}>Skip</BusyLabel></button>);
    const busy = renderToStaticMarkup(<button className={CHIP}><BusyLabel busy>Skip</BusyLabel></button>);
    expect(idle).not.toContain("data-busy");
    expect(busy).toContain("data-busy");
    expect(busy).toContain("opacity-0");
    expect(busy).toContain(">Skip<");
    expect(CHIP).toMatch(/^relative /);
  });

  it("turns Skip while a skip is recorded, disabled against a second tap", () => {
    const html = item(target(), { busy: true, pending: "dismiss" });
    const skip = buttonOf(html, "Skip");
    expect(skip?.[1]).toContain(DISABLED);
    expect(skip?.[1]).toContain('aria-busy="true"');
    expect(skip?.[2]).toContain("data-busy");
    // The other buttons wait, without a spinner of their own.
    expect(buttonOf(html, "Too long")?.[1]).toContain(DISABLED);
    expect(buttonOf(html, "Too long")?.[2]).not.toContain("data-busy");
  });

  it("turns the ⋯ button while Snooze, started from it, runs", () => {
    const html = item(target(), { busy: true, pending: "snooze" });
    expect(html).toMatch(/<button[^>]*aria-label="More"[^>]*aria-busy="true"[^>]*disabled/);
    const menu = renderToStaticMarkup(<MoreMenu items={[{ label: "Snooze a week", onSelect: noop }]} />);
    expect(menu).not.toContain("data-busy");
  });

  it("turns Bring back, and Skip on an item with no draft", () => {
    const back = item(target({ status: "dismissed", drafts: [] }), { busy: true, pending: "reopen" });
    expect(buttonOf(back, "Bring back")?.[2]).toContain("data-busy");
    expect(buttonOf(back, "Bring back")?.[1]).toContain(DISABLED);
    const fresh = item(target({ status: "qualified", drafts: [] }), { busy: true, pending: "dismiss" });
    expect(buttonOf(fresh, "Skip")?.[2]).toContain("data-busy");
    expect(buttonOf(fresh, "Draft it")?.[1]).toContain(DISABLED);
  });

  it("turns I posted it while it is recorded", () => {
    // The page holds `replied`; the item's own `posting` is what turns it, so
    // here only the disabled state of a busy item can be read statically.
    const html = item(target(), { busy: true, replied: true });
    expect(buttonOf(html, "I posted it")?.[1]).toContain(DISABLED);
    expect(source("components/placements/reply-item.tsx")).toContain("aria-busy={posting || undefined} onClick={onMarkPosted}");
  });

  it("shows the toast's Undo as a button that can turn while its request runs", () => {
    const html = renderToStaticMarkup(<Toast toast={{ id: 1, text: "Posted.", action: { label: "Undo", onClick: noop } }} onDismiss={noop} />);
    expect(html).toMatch(/<button[^>]*relative[^>]*>Undo<\/button>/);
    expect(source("components/placements/toast.tsx")).toContain("result instanceof Promise");
  });

  it("tracks the move each item waits on, per item, so one item never freezes another", () => {
    const page = source("app/(app)/today/page.tsx");
    expect(page).toContain("setPending((current) => ({ ...current, [id]: action }))");
    expect(page).toContain("pending={pending[target.id] ?? null}");
  });
});

describe("the link sheet after I posted it", () => {
  const sheet = (initialValue = "") =>
    renderToStaticMarkup(<LinkSheet target={target()} onSave={async () => null} onClose={noop} initialValue={initialValue} />);

  it("is a dialog with Paste link, Save and Skip above the field, and the X hint", () => {
    const html = sheet();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("On X: your reply → Share → Copy link");
    expect(linkHint("reddit")).toBeNull();
    expect(html.indexOf("Paste link")).toBeLessThan(html.indexOf("<input"));
    expect(html.indexOf(">Skip<")).toBeLessThan(html.indexOf("<input"));
    // 16px field on a phone, thumb-sized buttons.
    expect(html).toMatch(/<input[^>]*text-base/);
    expect(html).toContain("min-h-11");
    // A bottom sheet on a phone, a centred modal from md up.
    expect(html).toContain("items-end");
    expect(html).toContain("md:items-center");
  });

  it("keeps Save off until the link passes the same check, and says why under the field", () => {
    expect(buttonOf(sheet(), "Save")?.[1]).toContain(DISABLED);
    const wrong = sheet("https://x.com/maya_builds/status/1900000000000000001");
    expect(buttonOf(wrong, "Save")?.[1]).toContain(DISABLED);
    expect(wrong).toContain('role="alert"');
    const right = sheet("https://x.com/me/status/1900000000000000002");
    expect(buttonOf(right, "Save")?.[1]).not.toContain(DISABLED);
    expect(right).not.toContain('role="alert"');
  });

  it("saves a link that passes, and nothing for one that does not", async () => {
    const save = vi.fn(async () => null);
    expect(await saveTypedLink({ value: "https://x.com/me/status/1900000000000000002", target: target(), save })).toBeNull();
    expect(save).toHaveBeenCalledWith("https://x.com/me/status/1900000000000000002");
    save.mockClear();
    expect(await saveTypedLink({ value: "not a link", target: target(), save })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    // The short links the platforms' Share buttons hand out are accepted.
    const li = target({ surface: "linkedin", url: "https://www.linkedin.com/posts/anna-keller_aeo-activity-7391234567890123456-AbCd" });
    expect(await saveTypedLink({ value: "https://lnkd.in/dAbC123", target: li, save })).toBeNull();
    const quora = target({ surface: "quora", url: "https://www.quora.com/How-do-I-get-cited" });
    expect(await saveTypedLink({ value: "https://qr.ae/pYxYz1", target: quora, save })).toBeNull();
  });

  it("pastes and saves at once when the clipboard's link passes (the Paste link of a row)", () => {
    expect(source("components/placements/link-sheet.tsx")).toContain("pasteLinkFor({ target, read: readClipboard, save: onSave })");
  });

  it("is opened once I posted it is recorded, and every way out but Save keeps the reply posted with no link", () => {
    const page = source("app/(app)/today/page.tsx");
    const sheetSource = source("components/placements/link-sheet.tsx");
    // Recorded first (the request in `act`), then the sheet.
    const branch = page.slice(page.indexOf('if (action === "mark_published")'));
    expect(branch.indexOf("setLinkSheet(target)")).toBeGreaterThan(-1);
    expect(page.indexOf("const result = await post(`/api/placements/${id}/action`")).toBeLessThan(page.indexOf("setLinkSheet(target)"));
    // Skip, the close button, the backdrop and Escape all close as "skipped".
    expect(sheetSource.match(/onClose\("skipped"\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sheetSource).toContain('closeRef.current("skipped")');
    // Closing never unposts: the only unmark is the toast's Undo.
    const close = page.slice(page.indexOf("const closeLinkSheet"), page.indexOf("const closeLinkSheet") + 900);
    expect(close.match(/unmark_published/g)).toHaveLength(1);
    expect(close).toContain('outcome === "skipped"');
    expect(linkSheetToast("skipped")).toEqual({ text: "Posted.", action: { label: "Undo" } });
    expect(linkSheetToast("saved").action).toBeUndefined();
  });

  it("turns the page's shortcuts off while it is open", () => {
    expect(shortcutFor({ key: "j" })).toBe("next");
    expect(shortcutFor({ key: "j" }, { dialogOpen: true })).toBeNull();
    expect(shortcutFor({ key: "p" }, { dialogOpen: true })).toBeNull();
    expect(source("app/(app)/today/page.tsx")).toContain("shortcutFor(event, { dialogOpen: sheetOpen || todayOpen })");
  });
});

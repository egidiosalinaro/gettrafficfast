import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OEMBED_ENDPOINT,
  embedDay,
  handleFromAuthorUrl,
  oembedUrl,
  parseOembed,
  postFromEmbedHtml,
  readXPost,
} from "@/lib/providers/x/oembed";
import { xStatusPostedAt } from "@/lib/providers/x/status-time";

/**
 * Reading one post through X's oEmbed. What is pinned: the text comes out of
 * the embed's HTML as a reader sees it (entities decoded, line breaks kept,
 * mentions and links as the words they show, media links dropped), the
 * account comes from `author_url`, the date line is a day, and anything X
 * will not hand over is null, never an empty post.
 */

/** The shape publish.twitter.com/oembed answers with, `omit_script=1`, `dnt=true`. */
const EMBED_HTML =
  '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">' +
  "Shipping a new feature today 🚀<br><br>" +
  'Big thanks to <a href="https://twitter.com/jack?ref_src=twsrc%5Etfw">@jack</a> &amp; the team. ' +
  'Notes here: <a href="https://t.co/AbCdEf123">example.com/notes/launch…</a><br>' +
  "It&#39;s   live for everyone 🎉 " +
  '<a href="https://twitter.com/hashtag/buildinpublic?src=hash&amp;ref_src=twsrc%5Etfw">#buildinpublic</a> ' +
  '<a href="https://t.co/Zz9Yy8Xx7">pic.twitter.com/Zz9Yy8Xx7</a></p>' +
  '&mdash; Jane Doe (@janedoe) <a href="https://twitter.com/janedoe/status/1852000000000000000?ref_src=twsrc%5Etfw">October 31, 2024</a>' +
  "</blockquote>\n";

const PAYLOAD = {
  url: "https://twitter.com/janedoe/status/1852000000000000000",
  author_name: "Jane Doe",
  author_url: "https://twitter.com/janedoe",
  html: EMBED_HTML,
  width: 550,
  height: null,
  type: "rich",
  cache_age: "3153600000",
  provider_name: "Twitter",
  provider_url: "https://twitter.com",
  version: "1.0",
};

describe("postFromEmbedHtml", () => {
  it("takes the text as a reader sees it: line breaks kept, mentions, links and emoji as shown, media dropped", () => {
    const { text, postedOn } = postFromEmbedHtml(EMBED_HTML);
    expect(text).toBe(
      "Shipping a new feature today 🚀\n\n" +
        "Big thanks to @jack & the team. Notes here: example.com/notes/launch…\n" +
        "It's live for everyone 🎉 #buildinpublic"
    );
    expect(text).not.toMatch(/<|&amp;|&#39;|pic\.twitter\.com|Jane Doe/);
    expect(postedOn).toBe("2024-10-31T00:00:00.000Z");
  });

  it("returns no text for HTML that is not an embed, rather than guessing", () => {
    expect(postFromEmbedHtml("<div>nothing here</div>")).toEqual({ text: "", postedOn: null });
    expect(postFromEmbedHtml('<blockquote><p></p>&mdash; X <a href="https://twitter.com/x/status/1">Someday</a></blockquote>')).toEqual({
      text: "",
      postedOn: null,
    });
  });

  it("never runs what the HTML carries: a script is text at most, a tag never", () => {
    const { text } = postFromEmbedHtml('<blockquote><p>hi <b>there</b><img src=x onerror="alert(1)"></p></blockquote>');
    expect(text).toBe("hi there");
  });
});

describe("parseOembed", () => {
  it("maps the answer to the post, with the account from author_url", () => {
    expect(parseOembed(PAYLOAD)).toEqual({
      text: expect.stringMatching(/^Shipping a new feature today 🚀\n\nBig thanks to @jack/),
      authorName: "Jane Doe",
      handle: "janedoe",
      postedOn: "2024-10-31T00:00:00.000Z",
      hasMedia: true,
      // The links in the text, as the reader sees them, media left out.
      links: [
        { href: "https://twitter.com/jack?ref_src=twsrc%5Etfw", text: "@jack" },
        { href: "https://t.co/AbCdEf123", text: "example.com/notes/launch…" },
        { href: "https://twitter.com/hashtag/buildinpublic?src=hash&ref_src=twsrc%5Etfw", text: "#buildinpublic" },
      ],
    });
  });

  it("is null for an answer without HTML or without text", () => {
    expect(parseOembed({ error: "Sorry, you are not authorized to see this status." })).toBeNull();
    expect(parseOembed(null)).toBeNull();
    expect(parseOembed({ ...PAYLOAD, html: "<blockquote></blockquote>" })).toBeNull();
  });
});

describe("handleFromAuthorUrl and embedDay", () => {
  it("reads the account only from a profile URL on X", () => {
    expect(handleFromAuthorUrl("https://twitter.com/janedoe")).toBe("janedoe");
    expect(handleFromAuthorUrl("https://x.com/Jane_Doe")).toBe("Jane_Doe");
    expect(handleFromAuthorUrl("https://twitter.com/janedoe/status/1")).toBeNull();
    expect(handleFromAuthorUrl("https://example.com/janedoe")).toBeNull();
    expect(handleFromAuthorUrl(null)).toBeNull();
  });

  it("reads the date line as a day, and nothing else as one", () => {
    expect(embedDay("February 29, 2024")).toBe("2024-02-29T00:00:00.000Z");
    expect(embedDay("February 30, 2024")).toBeNull();
    expect(embedDay("3h")).toBeNull();
  });
});

describe("xStatusPostedAt", () => {
  it("reads the moment from a post id", () => {
    // US Dept of the Interior, posted 3 September 2014.
    expect(xStatusPostedAt("507185938620219395")).toBe("2014-09-03T15:18:45.483Z");
    expect(xStatusPostedAt("1852000000000000000")).toBe("2024-10-31T14:49:43.153Z");
  });

  it("leaves the counter ids from before 2011, and ids from the future, unknown", () => {
    expect(xStatusPostedAt("20")).toBeNull();
    expect(xStatusPostedAt("29700859247")).toBeNull();
    expect(xStatusPostedAt("1852000000000000000", new Date("2020-01-01T00:00:00Z"))).toBeNull();
    expect(xStatusPostedAt("not-a-number")).toBeNull();
  });
});

describe("readXPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  const POST_URL = "https://x.com/janedoe/status/1852000000000000000";

  it("asks the official endpoint for the post, without the script and with do-not-track", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));
    const post = await readXPost(POST_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(post?.handle).toBe("janedoe");
    const called = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(`${called.origin}${called.pathname}`).toBe(OEMBED_ENDPOINT);
    expect(called.searchParams.get("url")).toBe(POST_URL);
    expect(called.searchParams.get("omit_script")).toBe("1");
    expect(called.searchParams.get("dnt")).toBe("true");
    expect(oembedUrl(POST_URL)).toBe(String((fetchImpl.mock.calls[0] as unknown[])[0]));
  });

  it("uses the global fetch when none is given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
    expect((await readXPost(POST_URL))?.text).toMatch(/^Shipping/);
  });

  it("is null for a protected or deleted post, a broken answer, or no answer at all", async () => {
    const answer = (response: Response | Error) =>
      vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      }) as unknown as typeof fetch;
    expect(await readXPost(POST_URL, { fetchImpl: answer(new Response("Forbidden", { status: 403 })) })).toBeNull();
    expect(await readXPost(POST_URL, { fetchImpl: answer(new Response("Not Found", { status: 404 })) })).toBeNull();
    expect(await readXPost(POST_URL, { fetchImpl: answer(new Response("<html>", { status: 200 })) })).toBeNull();
    expect(await readXPost(POST_URL, { fetchImpl: answer(new TypeError("fetch failed")) })).toBeNull();
  });

  it("gives up after the timeout instead of holding the request open", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    ) as unknown as typeof fetch;
    const started = Date.now();
    expect(await readXPost(POST_URL, { fetchImpl, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

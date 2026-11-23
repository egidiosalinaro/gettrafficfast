import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentScreen, type ConsentScreenProps } from "@/components/oauth/consent-screen";

/**
 * The consent screen, rendered. What is pinned: who asks and where the
 * answer goes are on the page; Read and Write are ticked and Spend and
 * Publish are not, as on a new API key; the person's selected site is the
 * default; the request travels in hidden fields; Deny comes first in the
 * markup, so Enter declines; a loopback address gets a warning; the copy has
 * no em dash.
 */

const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const props: ConsentScreenProps = {
  action: "/oauth/authorize/decision",
  hidden: [
    ["client_id", "gtfci_x"],
    ["state", "s"],
  ],
  clientName: "Claude",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  requestedScopes: ["read", "write", "spend", "publish"],
  defaultScopes: ["read", "write"],
  sites: [
    { id: SITE_A, name: "Acme", website_url: "https://acme.test" },
    { id: SITE_B, name: "Bravo", website_url: "https://bravo.test" },
  ],
  defaultSite: SITE_B,
  email: "owner@acme.test",
  notice: null,
};

/** Every <input> of one kind, as `{ name, value, checked }`, in page order. */
function inputs(html: string, type: string) {
  return [...html.matchAll(/<input [^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`type="${type}"`))
    .map((tag) => ({
      name: /name="([^"]*)"/.exec(tag)?.[1],
      value: /value="([^"]*)"/.exec(tag)?.[1],
      checked: tag.includes('checked=""'),
    }));
}

describe("ConsentScreen", () => {
  it("shows who asks and where the answer goes, with Read and Write ticked and Spend and Publish not", () => {
    const html = renderToStaticMarkup(<ConsentScreen {...props} />);
    expect(html).toContain("Connect Claude?");
    expect(html).toContain('<strong class="break-all">claude.ai</strong>');
    expect(html).toContain("owner@acme.test");
    expect(inputs(html, "checkbox")).toEqual([
      { name: "grant", value: "read", checked: true },
      { name: "grant", value: "write", checked: true },
      { name: "grant", value: "spend", checked: false },
      { name: "grant", value: "publish", checked: false },
    ]);
    expect(html).toContain("Spend and Publish stay off unless you tick them.");
    expect(inputs(html, "radio")).toEqual([
      { name: "site", value: SITE_A, checked: false },
      { name: "site", value: SITE_B, checked: true },
      { name: "site", value: "all", checked: false },
    ]);
    expect(html).toContain("Only Acme");
    expect(inputs(html, "hidden")).toEqual([
      { name: "client_id", value: "gtfci_x", checked: false },
      { name: "state", value: "s", checked: false },
    ]);
    expect(html).toContain('action="/oauth/authorize/decision"');
    expect(html.indexOf('value="deny"')).toBeLessThan(html.indexOf('value="allow"'));
    expect(html).not.toContain("on your own computer");
    expect(html).not.toContain("\u2014");
  });

  it("offers only what the app asked for", () => {
    const html = renderToStaticMarkup(<ConsentScreen {...props} requestedScopes={["read"]} defaultScopes={["read"]} />);
    expect(inputs(html, "checkbox").map((box) => box.value)).toEqual(["read"]);
    expect(html).not.toContain("Spend and Publish stay off");
  });

  it("warns about a loopback address, and shows a notice", () => {
    const html = renderToStaticMarkup(
      <ConsentScreen {...props} redirectUri="http://localhost:3118/callback" notice="Tick at least one permission, or choose Deny." />
    );
    expect(html).toContain("localhost:3118");
    expect(html).toContain("on your own computer");
    expect(html).toContain('role="alert"');
  });

  it("says that with All my sites the app picks the site named in each request, the oldest by default", () => {
    const html = renderToStaticMarkup(<ConsentScreen {...props} />);
    expect(html).toContain("Claude can work on any of them, a different one in each request: name the site in your message");
    expect(html).toContain("run my day for Bravo");
    expect(html).toContain("When you name none, the tools act on your oldest site, Acme.");
    expect(html).not.toContain("Claude cannot name one");
    const single = renderToStaticMarkup(<ConsentScreen {...props} sites={[props.sites[0]]} defaultSite="all" />);
    expect(single).toContain("The tools act on Acme, and on any site you add later when you name it in your message.");
  });

  it("offers every site when the account has none yet", () => {
    const html = renderToStaticMarkup(<ConsentScreen {...props} sites={[]} defaultSite="all" />);
    expect(inputs(html, "radio")).toEqual([{ name: "site", value: "all", checked: true }]);
    expect(html).toContain("You have not added a site yet.");
  });
});

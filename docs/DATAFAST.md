# DataFast visitor analytics

Visitor analytics for this website. It is not the product's traffic
measurement: Search Console ingestion lives in `docs/ANALYTICS.md` and answers
what a customer's site received from Google. DataFast answers how people move
around the deployment's own site. Optional: a deployment without
`NEXT_PUBLIC_DATAFAST_WEBSITE_ID` loads no script at all.

## Where it loads, and only after consent

DataFast's default script sets cookies (a visitor id and a session id), so
under EU and Italian rules (Garante, cookie guidelines of 10 June 2021) it
needs the visitor's consent before it loads. Since 2026-11-17 the script is
mounted by the cookie banner, never directly:

- `app/layout.tsx`, the root layout, renders `<CookieConsent>`
  (`components/cookie-consent.tsx`) when `NEXT_PUBLIC_DATAFAST_WEBSITE_ID` is
  set. Every route has it: marketing pages, blog, docs, legal pages and the
  signed-in app (which has no copy of its own). No id: no banner, no
  "Cookie settings" link, no script.
- The banner reads the stored choice on the client. No choice: it shows a
  bottom bar with **Reject** and **Accept**, styled identically, nothing
  pre-selected, a line saying the sign-in cookies are always on, and a link
  to `/privacy-policy#cookies`. The server render carries the banner
  `hidden`, so a returning visitor never sees it flash.
- The `<Script>` is rendered only when the state is an explicit, current
  `granted` (`analyticsAllowed`, `lib/cookie-consent.ts`). Before a choice,
  after Reject, or with storage blocked, there is no script and DataFast
  sets nothing.
- The choice is kept in `localStorage` under `gtf-cookie-consent` as
  `{ v, choice, at }`. It holds six months (`CONSENT_MAX_AGE_MONTHS`), then
  the banner asks again. Raising `CONSENT_VERSION` asks everyone again: do it
  when what the visitor agreed to changes (a new analytics tool, a new
  purpose). Every storage call is in try/catch; a browser that refuses
  storage is asked on each visit and gets no script unless it accepts.
- **Cookie settings** reopens the banner: a button in the landing footer
  (`components/landing/footer.tsx`) and in the privacy policy's cookies
  section. It fires `gtf:open-cookie-settings` on `window`.
- Rejecting after having accepted deletes the `datafast_*` cookies (on the
  host and its parent domains) and reloads the page, since a script that has
  run cannot be unloaded.

```tsx
{analyticsAllowed(state) ? (
  <Script
    src="https://datafa.st/js/script.js"
    data-website-id={websiteId}
    data-domain={domain}
    strategy="afterInteractive"
  />
) : null}
```

Tests: `tests/site/cookie-consent.test.tsx` (no script before a choice,
script after Accept, never after Reject, reopen from the footer, six months,
storage failures, no banner without the id) and `tests/site/datafast.test.ts`
(where it is mounted).

`strategy="afterInteractive"` is the Next.js equivalent of `defer`: the script
loads after the page is interactive, on the client. The website id is the
DataFast property (`NEXT_PUBLIC_DATAFAST_WEBSITE_ID`); the domain is the host
of `SITE_URL` (`NEXT_PUBLIC_SITE_URL`). Both must match the property set up in
DataFast, or nothing is recorded.

The vendor script does not record localhost. A local `next dev` session will
show the tag and will not send a pageview.

The snippet is the default script (`/js/script.js`), the one configured for
this property. The cookieless build is a different URL and is not what this
site loads.

## Content-Security-Policy

There is no CSP today (`next.config.ts`, `vercel.json`, `middleware.ts`). If
one is added, `https://datafa.st` has to be allowed in both `script-src` (the
tag loads) and `connect-src` (the script sends the pageview). A policy that
names one and not the other looks installed and records nothing.

The privacy policy names DataFast as the service that measures visits to this
website, with consent as the legal basis, and describes the banner and the
six-month choice in `#cookies` (docs/LEGAL.md).

Consequence for the numbers: visitors who reject or never answer are not
counted, so DataFast undercounts real traffic. Read its figures as visits by
people who accepted, not as all visits.

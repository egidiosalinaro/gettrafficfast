# DataFast visitor analytics

Visitor analytics for this website. It is not the product's traffic
measurement: Search Console ingestion lives in `docs/ANALYTICS.md` and answers
what a customer's site received from Google. DataFast answers how people move
around the deployment's own site. Optional: a deployment without
`NEXT_PUBLIC_DATAFAST_WEBSITE_ID` loads no script at all.

## Where it loads

`app/layout.tsx`, the root layout, so every route gets the script — marketing
pages, the app, the blog, legal pages. Nested layouts do not mount a second
copy.

```tsx
{DATAFAST_WEBSITE_ID ? (
  <Script
    src="https://datafa.st/js/script.js"
    data-website-id={DATAFAST_WEBSITE_ID}
    data-domain={SITE_HOST}
    strategy="afterInteractive"
  />
) : null}
```

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
website.

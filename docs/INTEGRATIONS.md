# Publishing integrations

> Destinations are **publisher adapters** over the Canonical Article. An adapter
> receives a validated document and maps it onto its API — it never parses or
> sanitises content. See `docs/CONTENT_PIPELINE.md`.

Articles are published to the **customer's** site through the `integrations`
table (one row per `(business_id, type)` — a destination belongs to a site, not
to an account, so one login can publish one site to WordPress and another to
its own blog; RLS still restricts every row to its owner and the cron reads
them with the service-role client). Credentials in `config` are
encrypted at rest with AES-256-GCM (`lib/integrations/crypto.ts`, key from
`INTEGRATIONS_ENCRYPTION_KEY`) and are never returned to the client
(`/api/integrations/list` strips `*_encrypted` fields).

UI: **Settings → Connections** (`/settings/integrations`; the path is kept
because Google's consent screen and the emails return to it) →
`/settings/integrations/wordpress`, `/settings/integrations/webhook`, and
`/settings/integrations/search-console`, each with "‹ Connections" at the top.
Since 2026-11-14 the page is three groups: **Google** (Search Console),
**X** (the site's Find posts on X switch, `voice_settings.findPostsOnX`,
moved here from Settings → Voice and saved through the partial
`PATCH /api/business/voice-settings`, the merge `update_voice_settings`
runs), and **Your blog** (WordPress, Webhooks; Shopify, Wix, Webflow and
Framer named as coming soon, not offered).

The Connected badge on each row is the union of two tables:
`integrations` (publishing destinations) and `analytics_connections` (Search
Console). The second table is not a publisher — see `docs/ANALYTICS.md` — but
the catalog is one screen, so a connected grant has to show the same way a
connected webhook does. `connectedCatalogIds` in `lib/integrations/catalog.ts`
is that mapping; looking only at `integrations` leaves Search Console looking
unconnected.

This site's own blog is not a separate destination: gettrafficfa.st connects
the Webhooks integration like any other Next.js customer and receives its
articles at `/api/gettrafficfast` (`docs/BLOG.md`). Deliveries to that URL
are signed with `BLOG_WEBHOOK_SECRET` rather than a second copy stored in
`integrations.config`. A private path for the product's own domain would have
left this delivery code as the one piece never exercised on ourselves.

That URL is reserved for the operator. Only a user id listed in
`OWN_BLOG_OWNER_USER_IDS` (server env, comma-separated) may connect it, and
only such a row is ever signed with `BLOG_WEBHOOK_SECRET`
(`lib/publishing/own-blog.ts`, `lib/publishing/webhook-secret.ts`). The
decision comes from two facts a user cannot write: the URL is the own
receiver, and the row's `user_id` is an operator. Nothing in `config` opts a
row in; a legacy `secret_from_env` flag is ignored. Unset means nobody: the
check fails closed.

## Network safety: every customer URL goes through `safeFetch`

Webhook URLs, WordPress sites and the site analysed at onboarding are typed by
the customer, so the server never fetches them with plain `fetch`.
`lib/providers/safe-fetch.ts` (used by `lib/publishing/http.ts` and
`lib/research/website.ts`):

- http and https only;
- every address the host resolves to must be public: private, loopback,
  link-local (incl. `169.254.169.254`), CGNAT, multicast, documentation and
  unique-local ranges are refused, IPv4 and IPv6;
- the check is repeated inside the socket's own DNS lookup, so DNS rebinding
  cannot swap in a private address between check and connect;
- redirects are followed by hand, at most 5, each hop re-checked, and
  `Authorization` is dropped when the origin changes;
- one timeout for the whole exchange and a body-size ceiling.

The webhook connect test answers a failure with one generic sentence ("Could
not reach that address…"). The precise reason (refused, timed out, blocked) is
logged on the server only: echoing it would let the form probe which ports are
open on someone's network.

## WordPress (`lib/publishing/adapters/wordpress.ts`)

- Connect: `POST /api/integrations/wordpress/connect` validates the credentials
  with `GET /wp-json/wp/v2/users/me` before saving.
- Config: `{site_url, username, application_password_encrypted}`.
- Publish: `POST /wp-json/wp/v2/posts` with `{title, content, status: "publish",
  slug}` (slug derived from the keyword); the returned `link` becomes
  `articles.published_url`.

## Webhook (`lib/publishing/adapters/webhook.ts`) — for custom sites

- Connect: the customer pastes their endpoint URL and shared secret in
  Settings → Connections → Webhook (they never need this repository). The
  in-app prompt tells their coding agent to put the same secret in
  `GTF_WEBHOOK_SECRET` on *their* site. `POST /api/integrations/webhook/connect`
  sends a signed `{event: "test"}` request; any 2xx response passes.
- Config: `{url, secret_encrypted}`. The pasted secret is encrypted at rest.
  The `BLOG_WEBHOOK_SECRET` path is only for this deployment's own receiver,
  and only for an operator in `OWN_BLOG_OWNER_USER_IDS` (`docs/BLOG.md`).
  Anyone else who enters that URL gets a 403.
- Recent deliveries on that page are filtered by the selected `business_id`.
  `user_id` is ownership; without the site key a multi-business account saw
  every webhook delivery in the same list.
- Publish payload (`POST`, `Content-Type: application/json`):

  ```json
  {
    "event": "article.publish",
    "title": "Article title",
    "slug": "article-slug",
    "html": "<h1>...</h1>...",
    "keyword": "target keyword",
    "scheduled_date": "2026-07-20"
  }
  ```

- Signature, two schemes on every request (`lib/publishing/webhook-signature.ts`),
  keyed with the shared secret. Receivers must verify one before trusting the
  payload:
  - **v2 (current)**: `X-GTF-Timestamp` (Unix seconds) and
    `X-GTF-Signature: v2=<hex HMAC-SHA256 of "timestamp.rawBody">`. The
    receiver rejects a timestamp more than 5 minutes off and may drop a
    `delivery_id` (payload v7, unique per request) it has already seen, so a
    captured delivery cannot be replayed.
  - **v1 (legacy, deprecated)**: `X-Signature`, hex HMAC-SHA256 of the raw
    body alone. Still sent so receivers written for it keep working, but it
    has no timestamp: a captured delivery verifies forever. It will be
    dropped only after an announced notice period, never in place.
- The endpoint must answer `200` with `{"url": "https://..."}` — the public URL
  of the published post, stored in `articles.published_url`.

For customers on custom Next.js sites, `docs/NEXTJS_WEBHOOK_RECEIVER.md` has a
complete copy-paste receiving endpoint (HMAC verification included).

## Readable by AI answer engines (both destinations)

What the customer's own site serves to AI crawlers is theirs to set, so GTF
gives guidance, not a setting: the public docs (`/docs#ai-crawlers`) give
WordPress customers the robots.txt lines and a note on llms.txt plugins, the
webhook agent prompt (`components/integrations/ai-agent-prompt.tsx`) asks for
the robots group and an `/llms.txt` route, and
`docs/NEXTJS_WEBHOOK_RECEIVER.md` §6 has both as code. The crawler names come
from `lib/ai-crawlers.ts`. The copy says these help crawlers find and read
pages, never that they get a site cited: citation is sampled.

## Failure handling

A failed publish marks the integration `status='error'` with `last_error`
(surfaced in the settings UI) and leaves the article in `generated`. The cron
retries errored integrations on every run and resets them to `connected` on the
first success. See `docs/SCHEDULED_AI_ARTICLES.md` for the article status flow.

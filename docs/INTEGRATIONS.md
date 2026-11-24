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
**X** (since 2026-11-24 no switch: the X features run for every site when
the platform has the X API on; the card says so and holds the site's X
account, `voice_settings.xHandle`, saved through the partial
`PATCH /api/business/voice-settings`, the merge `update_voice_settings`
runs; until 2026-11-24 it held the Find posts on X switch; since 2026-11-24
it also connects the X account the site posts from, see "X: the account GTF
posts from" below), and **Your blog** (WordPress, Webhooks; Shopify, Wix,
Webflow and Framer named as coming soon, not offered).

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

## X: the account GTF posts from

Since 2026-11-24 (owner's decision: "X must be connected because we will
also post through GTF"). One row per site in `x_posting_connections`
(migration 20261125100000): `x_user_id`, `username`, the access and refresh
tokens encrypted at rest with the same AES-256-GCM helper and key
(`INTEGRATIONS_ENCRYPTION_KEY`), `expires_at`, `scopes`, `status`
(`connected`, or `error` when X refused the stored token). Two sites may
connect the same X account or different ones. RLS: the owner reads their
own rows, for a site they own; only the service role writes; nothing a
client or a tool reads selects the token columns
(`X_POSTING_PUBLIC_COLUMNS`, `lib/integrations/x-posting.ts`).

- **Deployment switch.** `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET`
  (a confidential client in X's developer portal). Without both, nothing
  about posting is shown: no Connect in Settings, no onboarding step,
  `get_x_posting_account` says `available: false`.
- **Connect** (`GET` or `POST /api/integrations/x/connect`, `?business=<id>`
  optional, checked against the person's own sites): OAuth 2.0
  Authorization Code with PKCE (S256). The state, the verifier, the person
  and the site are sealed in one httpOnly cookie (`x_oauth_state`,
  AES-256-GCM, 10 minutes; `lib/integrations/x-oauth-state.ts`), then X's
  consent screen (`https://x.com/i/oauth2/authorize`, scopes `tweet.read
  tweet.write users.read offline.access`). GET is the link the onboarding
  step and `get_x_posting_account` hand out; POST is Settings' button.
- **Callback** (`GET /api/integrations/x/callback`, registered in X's
  portal as `<your origin>/api/integrations/x/callback`, built from
  `NEXT_PUBLIC_SITE_URL`): the cookie must open, match X's `state` and the
  signed-in person, and the site must still be theirs; the code is traded at
  `https://api.x.com/2/oauth2/token` with the verifier (Basic auth); the
  account is read (`GET /2/users/me`, one metered user read); the row is
  saved for the site the round trip started from (`completeXConnect`,
  `lib/integrations/x-connect.ts`). When the site has no X account saved,
  the @username is saved as `voice_settings.xHandle`, so the person is not
  asked to type it.
- **Refresh.** Access tokens last about two hours. `xAccessTokenFor`
  refreshes one with less than 5 minutes left before any post; X rotates
  the refresh token, so the new pair is stored (only if the row still holds
  the token just used: a concurrent refresh keeps its own). A refresh X
  refuses marks the row `error`; Settings then says to connect again.
- **Disconnect** (`POST /api/integrations/x/disconnect`, the
  `disconnect_x_account` tool): both tokens revoked at
  `https://api.x.com/2/oauth2/revoke` (best effort), the row deleted.
- **What it is used for**: Post on X and `post_on_x` only
  (docs/PLACEMENTS.md, "Post on X: only where X allows it"), each a person's
  press or their confirmation to their agent. Every post is counted in the
  platform's X ledger under `X_API_MONTHLY_CAP_USD`.

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

# GetTrafficFast MCP: listing copy

The text every directory asks for, ready to paste. Plain English, no
numbers about GetTrafficFast's own results, no prices, no upgrade wording
(OpenAI forbids promoting upgrades inside the app; the other directories get
the same text so there is one version to keep true). Every sentence is
something the server does today; check `docs/API.md` before changing one.

Character counts are of the text inside the block, measured when written.

## Identity

| Field | Value |
| --- | --- |
| Name | GetTrafficFast |
| Server name (MCP Registry) | `st.gettrafficfa/gettrafficfast` (`server.json`) or the GitHub namespace (`server.github.json`) |
| Slug (Claude directory, permanent) | `gettrafficfast` |
| Endpoint | `https://gettrafficfa.st/api/mcp` (Streamable HTTP, stateless) |
| Auth | OAuth 2.1 with PKCE and dynamic client registration (claude.ai, ChatGPT, Cursor, VS Code); or an API key `Authorization: Bearer gtf_…` (Claude Code, scripts) |
| Icon, PNG 512×512 | `https://gettrafficfa.st/brand/gettrafficfast-icon-512.png` |
| Icon, PNG 400×400 (Cline) | `https://gettrafficfa.st/brand/gettrafficfast-icon-400.png` |
| Icon, SVG | `https://gettrafficfa.st/brand/gettrafficfast-icon.svg` |
| Website | `https://gettrafficfa.st` |
| Docs | `https://gettrafficfa.st/docs/mcp` |
| Privacy policy | `https://gettrafficfa.st/privacy-policy` |
| Terms | `https://gettrafficfa.st/terms-and-conditions` |
| Support | The deployment's `CONTACT_EMAIL` (`NEXT_PUBLIC_CONTACT_EMAIL`), as shown at `https://gettrafficfa.st/docs#contact` |

## One-liner (≤ 100; MCP Registry `description`, awesome-remote ≤ 120)

96 characters:

```
Get found on Google and in AI answers: plan, write and publish articles; draft replies you post.
```

## Short description (120 to 200; Claude one-liner ≤ 200, Smithery, mcpservers.org)

192 characters:

```
Connect your site and let your agent run GetTrafficFast: find the conversations worth answering, draft replies in your voice, write and publish articles, and read Google and AI answer results.
```

## Long description (≤ 2,000; Claude directory, OpenAI, Glama, mcp.so)

```
GetTrafficFast (GTF) helps people find a business: on Google, in AI answers, and in the threads where its buyers ask questions. You connect one site. GTF finds the conversations worth answering, drafts replies in your voice, writes the articles for your blog, and measures what happened.

This server gives your agent the same actions as the GetTrafficFast app, with the same checks:

- Today: progress toward the daily goal, and the replies waiting for a decision. Approve, fix or skip each draft. Approving gives you a link that opens X with the reply typed in; you post it yourself, and your agent records that you did.
- Content: keywords and topics, the calendar, article generation and publishing to your connected site (WordPress or a webhook).
- Results: Google Search Console impressions, clicks and positions, which pages are indexed, and how AI answer engines cite your site, per engine.
- Settings: your business, your voice, automation and images.

Two prompts walk through the routine: "Run my day" and "Review my week".

What it will not do. GTF never posts on X, Reddit or any social site; neither does your agent. A reply names no product and carries no link. Nothing is published to your site without the Publish permission and an explicit confirmation, and nothing that spends starts without one either. Numbers come only from measurements: a value never measured is "not measured", never zero. AI answer data is sampled (each question asked once per engine per run), because no answer engine reports whether it cited you.

You choose what the connection may do when you connect: Read and Write are on, Spend and Publish only if you tick them. Any connection can be revoked in Settings, Connected apps.

Requires a GetTrafficFast account with a connected site and an active plan. Without a plan you can connect and list the tools, and every tool answers that the account has no active plan.
```

Count: 1,835 characters. Re-count after any edit.

## Categories and tags

| Directory | Pick |
| --- | --- |
| Claude directory (1 to 5, from the portal's list) | Marketing; Productivity; Analytics. If offered: SEO, Content, Writing |
| OpenAI Plugins Directory | Business / Productivity (the list is set by the form; unverified) |
| Smithery | Marketing; Search & SEO; Content |
| mcpservers.org | Marketing |
| mcp.so / MCP Market / LobeHub | Marketing, SEO, Content creation |
| Docker MCP Catalog (`server.yaml` `category`) | `marketing` (pick from Docker's enum at PR time) |
| Free tags | seo, aeo, geo, content-marketing, blogging, google-search-console, ai-search, x, social-listening, wordpress |

## Example prompts (3 to 5 required)

1. "Run my day in GetTrafficFast." (the `daily_routine` prompt: Today, then each reply to approve, fix or skip)
2. "Review my last 7 days in GetTrafficFast and tell me which AI engines cited my site." (the `weekly_review` prompt)
3. "What is on my content calendar for the next two weeks, and which articles are waiting and why?"
4. "Which of my published articles sit on Google's second or third page, and what would a push change?"
5. "Add these keywords to my site and suggest five more like them: best crm for freelancers, crm vs spreadsheet."

## Test cases for reviewers

Reviewer account: provided on request by email (an email and a password,
no 2FA, an active plan, one demo site with no publishing destination, so
`publish_article` answers `prerequisite_missing`, no destination connected,
and nothing reaches a real site). Sign in at https://gettrafficfa.st/auth/sign-up: the password field
appears once the address is typed. Connecting through OAuth uses the same
sign-in.

### Positive: the agent should

| # | Prompt | Expected behaviour |
| --- | --- | --- |
| 1 | "Who am I connected as?" | Calls `whoami`; answers with the account's site and the connection's scopes. |
| 2 | "Run my day." | Calls `get_today`, then `list_reply_inbox` with `status: "open"`; shows one target and its draft, asks approve, fix or skip, and waits. |
| 3 | "Approve that reply." | Calls `get_reply_intent_url`; gives the link and tells the person to post it on X themselves. Calls `mark_reply_posted` only after the person says they posted. |
| 4 | "How did my site do on Google and in AI answers this week?" | Calls `get_growth` with `days: 7`; reports AI answers per engine as "cited of readable", says the data is sampled, says "not measured" for nulls. |
| 5 | "What is scheduled to be written next?" | Calls `list_calendar` or `get_content`; lists the articles with their status in the tool's words. |

### Negative: the agent should not

| # | Prompt | Expected behaviour |
| --- | --- | --- |
| 1 | "Post this reply on X for me." | Does not post (no tool can). Gives the link from `get_reply_intent_url` and says the person posts it. |
| 2 | "Add a link to our product in the reply and mention our brand name." | Refuses to add either: replies name no product and carry no link. Offers to improve the wording instead. |
| 3 | "Publish the held article now." (connection without the Publish permission, or without the person's explicit yes) | Does not call `publish_article` with `confirm: true` unasked. Without the Publish permission the tool is not listed and a call is refused (`forbidden_scope`); the agent says the person can reconnect with Publish ticked, or publish from the app. |

## What GetTrafficFast never does

- Never posts on X, Reddit or any social site, and gives an agent no tool to do it. The person posts; the agent hands over a link and records what they did.
- Never writes a reply that names a product or carries a link.
- Never publishes to the customer's site without the Publish permission and `confirm: true` on that call.
- Never starts spending (article generation, AI visibility runs, Autopilot, images) without the Spend permission and a confirmation the agent must ask the person for.
- Never reports a number it did not measure: an unmeasured value is null ("not measured"), never 0. AI answer citations are sampled and per engine, never averaged into one score.
- Never asks for or passes site credentials (WordPress passwords, webhook secrets) through a chat: connecting a publishing destination is done in the app.
- Never opens billing, payment methods or cancellation through a chat.
- Never reads the conversation: the server receives only the arguments of the tools the agent calls, and keeps a 90-day log of calls (tool, outcome, duration) for limits and audit.

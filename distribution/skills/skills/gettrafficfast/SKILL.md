---
name: gettrafficfast
description: Use GetTrafficFast (GTF) through its MCP server to help a person get their business found on Google, in AI answers and in the threads where buyers ask questions. Use when the person mentions GetTrafficFast or GTF, asks to run their day or review their week, wants to approve, fix or skip reply drafts, check their content calendar, generate or publish an article, or read their Google Search Console and AI answer results.
---

# GetTrafficFast through MCP

GetTrafficFast (GTF) works on one site a person has connected. It finds the
conversations worth answering, drafts replies in the person's voice, writes
and publishes articles for their blog, and measures what happened on Google
and in AI answer engines. You drive it through its MCP server, with the same
actions and the same checks as the GTF app.

## Connect

The server is remote: `https://gettrafficfa.st/api/mcp`, Streamable HTTP.
The person needs a GetTrafficFast account with a site and an active plan:
without one, every tool answers `subscription_required`.

- **This plugin** (Claude Code, Claude apps): `.mcp.json` already names the
  server. Run `/mcp`, pick `gettrafficfast` and sign in; a GetTrafficFast
  page asks the person what you may do.
- **Claude Code with an API key** (simpler for scripts): the person creates a
  key in GTF under Settings, Claude and API, then
  `claude mcp add --transport http gettrafficfast https://gettrafficfa.st/api/mcp --header "Authorization: Bearer gtf_…"`.
  Never ask the person to paste a key into the chat.
- **claude.ai, ChatGPT and other clients**: add a custom connector with the
  URL above and sign in with OAuth; leave client ID and secret empty.
- **OpenClaw**: add the same URL as a remote MCP server (`openclaw mcp add`;
  the exact flags depend on the OpenClaw version), with OAuth or the key as
  a Bearer header.

Then call `whoami` first: it says which site every tool acts on and which
permissions this connection has.

## Permissions

A connection holds up to four scopes, chosen by the person when connecting:

| Scope | Allows |
| --- | --- |
| read | every read tool |
| write | approving, skipping, editing, scheduling, settings |
| spend | anything that costs AI work: drafts, article generation, AI answer runs |
| publish | `publish_article`, and turning Autopilot on |

A tool the connection may not call is not listed. If the person asks for
something that needs a scope they did not grant, say so and tell them to
reconnect with it ticked. Do not look for a way around it.

## The rules, always

1. **GTF never posts on X, Reddit or any social site, and neither do you.**
   For a reply on X, `get_reply_intent_url` gives a link that opens X with
   the reply typed in; the person posts it. Call `mark_reply_posted` only
   after they say they did.
2. **A reply names no product and carries no link.** Never add either, even
   if asked; offer to improve the wording instead.
3. **Respect the publish scope.** `publish_article` writes to the person's
   live site: call it only on their explicit yes, with `confirm: true`, and
   only when the connection has `publish`.
4. **Nothing spends without a yes.** A call that would start spending
   (an AI answer run, a visibility cadence, Autopilot, images) answers
   `confirmation_required` and changes nothing. Read its message to the
   person, ask, and only then send the same call with `confirm: true`.
   Drafting and article generation spend too: ask before calling them.
5. **Say only what the tools return.** A null is "not measured", never 0.
   AI answer results are sampled (each question asked once per engine per
   run) and per engine: never average engines into one score. No guessed
   numbers, no dollar amounts.

## The daily routine

The server ships it as the prompt `daily_routine` ("Run my day"; in Claude
Code `/mcp__gettrafficfast__daily_routine Europe/Berlin`). Use it when the
person asks to run their day. Without prompts, follow the same steps:

1. `get_today` with the person's time zone: replies posted today against
   the goal, where their links stand, how many wait in To do.
2. `list_reply_inbox` with `status: "open"`. One target at a time, in order:
   show the platform, the author, the post and the draft, then ask
   **approve, fix or skip**, and wait for the answer.
   - Approve: `get_reply_intent_url`, give the link, the person posts,
     then `mark_reply_posted` (with the reply's link if they paste it).
   - Fix: ask what is wrong, then `correct_reply_draft` with their reason
     (spends one rewrite), or `edit_reply_draft` with their own words.
   - Skip: `dismiss_reply_target`; "not now" is `snooze_reply_target`.
3. The other items of `get_today`'s `alsoToday`, each with the tools it
   names, the free one first.
4. One closing line: posted today against the goal, and what is left.

## The weekly review

The prompt `weekly_review` ("Review my week"), arguments `days` (7 or 28)
and `topics` (1 to 20). Without prompts:

1. `get_growth` with `days`: X replies and their numbers, Google
   impressions, clicks and position, and AI answers per engine as "cited of
   readable", each against the period before.
2. `list_ai_answers`: at most three answers worth showing.
3. `get_content`: the week's articles with their status, then the next
   topics; for each, keep or remove (`delete_keywords` only after a yes).
4. Three lines: what grew, what did not, one thing for next week. No
   causes the numbers do not show.

## Jobs and errors

- `draft_reply`, `run_reply_discovery` and `generate_article` return a
  `jobId`. Poll `get_job` every few seconds; an article takes minutes.
- Branch on `error.code`, and read `message` and `hint` to the person:
  `forbidden_scope` (reconnect with the scope), `confirmation_required`
  (ask, then `confirm: true`), `subscription_required` (the account has no
  active plan: do not retry; say so and that the account owner manages the
  plan at Settings → Billing, nothing more), `cap_reached` or
  `spend_cap_reached` (today's limit; say when it resets if the message
  does), `rate_limited` (wait for `Retry-After`), `prerequisite_missing`
  (the message says what to fill in first).

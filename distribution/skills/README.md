# GetTrafficFast agent skills

Skills and a Claude plugin for using [GetTrafficFast](https://gettrafficfa.st)
from your agent, through its hosted MCP server at
`https://gettrafficfa.st/api/mcp`. This directory holds no server code: the
server is the rest of this repository (and runs at GetTrafficFast), and this
package teaches an agent how to use it well. It is MIT licensed
([`LICENSE`](LICENSE)), unlike the AGPL-3.0 code around it, so it can be
copied into any project.

GetTrafficFast works on one site you connect. It finds the conversations
worth answering, drafts replies in your voice, writes and publishes articles
for your blog, and measures what happened on Google and in AI answers. It
never posts on social sites: you do.

You need a GetTrafficFast account with a connected site and an active
plan: without one, every tool answers that the account has no active plan.

## What is here

```
.claude-plugin/plugin.json        the Claude plugin manifest
.claude-plugin/marketplace.json   makes this directory a marketplace on its own, if it is copied to a repo root
.claude-plugin/icon.png           512×512 listing icon
.mcp.json                         the remote MCP server the plugin connects to
skills/gettrafficfast/SKILL.md    how to use GetTrafficFast: connect, daily routine, weekly review, rules
```

The repository's root `.claude-plugin/marketplace.json` lists this
directory as the plugin's source (`./distribution/skills`), so the
GetTrafficFast repository itself is the marketplace: nothing has to be
copied to a separate repo.

## Install

**Claude Code**, as a plugin (the skill plus the server):

```sh
/plugin marketplace add egidiosalinaro/gettrafficfast
/plugin install gettrafficfast@gettrafficfast
```

Then `/mcp`, pick `gettrafficfast` and sign in. Or connect the server alone
with an API key from Settings, Claude and API:

```sh
claude mcp add --transport http gettrafficfast https://gettrafficfa.st/api/mcp \
  --header "Authorization: Bearer gtf_…"
```

**Any agent that reads skills** (skills.sh):

```sh
npx skills add https://github.com/egidiosalinaro/gettrafficfast/tree/main/distribution/skills
```

**OpenClaw** (ClawHub): `clawhub install gettrafficfast`, then add
`https://gettrafficfa.st/api/mcp` as a remote MCP server.

**claude.ai, ChatGPT, Cursor, VS Code**: add a custom connector or remote
MCP server with the URL above and sign in. Setup per client:
https://gettrafficfa.st/docs/mcp

## What the agent will never do

- Post on X, Reddit or any social site. It gives you a link; you post.
- Put a product name or a link in a reply.
- Publish to your site without the Publish permission and your explicit yes.
- Start anything that spends without asking you first.
- Report a number nobody measured. AI answer results are sampled, per engine.

## Links

- Docs: https://gettrafficfa.st/docs/mcp
- Privacy: https://gettrafficfa.st/privacy-policy
- Terms: https://gettrafficfa.st/terms-and-conditions
- Support: https://gettrafficfa.st/docs#contact

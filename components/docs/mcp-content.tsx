import Link from "next/link";
import { CONTACT_EMAIL, SITE_URL } from "@/lib/site";
import { SCOPE_COPY } from "@/components/settings/scope-copy";
import { PROMPTS } from "@/lib/tools/prompts";
import { MCP_SERVER_NAME } from "@/lib/tools/mcp";
import { PLAN_REQUIRED_MESSAGE, PRICING_URL } from "@/lib/paid-access";
import { MAX_LIVE_GRANTS, PROTECTED_RESOURCE_METADATA_URL } from "@/lib/oauth/config";
import { MAX_ACTIVE_API_KEYS } from "@/lib/api-keys";
import { TOOL_CALLS_RETENTION_DAYS } from "@/lib/tools/retention";
import { CopyText } from "./copy-text";
import { Bullets, Callout, Code, P, Place, Section, Steps, Strong, Sub, type DocsLimits } from "./docs-content";
import { ERROR_CODE_DOCS } from "./error-codes";
import type { ToolArea } from "./tool-areas";

/**
 * The public MCP reference (`/docs/mcp`): everything a person or an agent
 * needs to connect GetTrafficFast's MCP server from any client, and what it
 * will and will not do. MCP registries and agent directories link here, so
 * the address and the anchors (components/docs/mcp-sections.ts) stay put.
 *
 * Every sentence has to be true of the code. The tools come from the
 * registry, the limits from TOOL_LIMITS and the daily caps, the error codes
 * from lib/api-errors.ts (through ERROR_CODE_DOCS), the plan refusal from
 * PLAN_REQUIRED_MESSAGE, handed in or imported, never retyped. No traction
 * numbers and no prices: the pricing page holds those.
 */

export interface McpDocsProps {
  areas: readonly ToolArea[];
  limits: DocsLimits;
}

const MCP_URL = `${SITE_URL}/api/mcp`;
const TOOLS_URL = `${SITE_URL}/api/v1/tools`;
const KEY = "gtf_…";

const CLAUDE_CODE_KEY = `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL} --header "Authorization: Bearer ${KEY}"`;
const CLAUDE_CODE_OAUTH = `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL}`;
const CURSOR = JSON.stringify(
  { mcpServers: { [MCP_SERVER_NAME]: { url: MCP_URL, headers: { Authorization: `Bearer ${KEY}` } } } },
  null,
  2
);
const VSCODE = JSON.stringify(
  { servers: { [MCP_SERVER_NAME]: { type: "http", url: MCP_URL, headers: { Authorization: `Bearer ${KEY}` } } } },
  null,
  2
);
const GENERIC = `curl -X POST ${MCP_URL} \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
const ROUTINE_COMMAND = `/mcp__${MCP_SERVER_NAME}__daily_routine Europe/Berlin`;

function Link_({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-foreground underline underline-offset-4 break-all">
      {children}
    </a>
  );
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <span
      className={
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none " +
        (tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          : "border-border bg-muted text-muted-foreground")
      }
    >
      {children}
    </span>
  );
}

/** Two columns on a wide screen, stacked on a phone: a term and what it means. */
function Rows({ rows }: { rows: ReadonlyArray<{ term: React.ReactNode; detail: React.ReactNode; key: string }> }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-baseline sm:gap-3">
          <span className="font-medium text-foreground sm:w-56 sm:shrink-0">{row.term}</span>
          <span className="text-muted-foreground">{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function McpDocsContent({ areas, limits }: McpDocsProps) {
  const toolCount = areas.reduce((sum, area) => sum + area.tools.length, 0);

  return (
    <div className="min-w-0 space-y-14 text-[15px] leading-relaxed">
      <Section id="overview" title="What it does">
        <P>
          GetTrafficFast (GTF) helps people find a business on Google, in AI answers, and in the threads where its
          buyers ask questions. Its MCP server lets an AI agent (Claude, ChatGPT, Cursor, VS Code or your own) run the
          product for you: read your day, draft replies in your voice, plan and write articles, publish them to your
          own site when you allow it, and read what happened on Google and in AI answers.
        </P>
        <Bullets>
          <li>Every action you can take on the screens is a tool, with the same checks: your sites only, your plan, the daily caps.</li>
          <li>The agent works on one of your sites at a time, chosen when you connect or by a header.</li>
          <li>Nothing is posted on its own. The agent hands you a link and you post; the one exception is post_on_x, which posts on X from the account you connected for the site, only with the Publish permission and your yes to that post. Never Reddit or any other social site.</li>
        </Bullets>
      </Section>

      <Section id="server" title="Server">
        <CopyText text={MCP_URL} label="Copy the MCP server address" />
        <Rows
          rows={[
            { key: "name", term: "Name", detail: <Code>{MCP_SERVER_NAME}</Code> },
            {
              key: "transport",
              term: "Transport",
              detail: "Streamable HTTP, stateless: send JSON-RPC with POST; answers are JSON. No session id, no server-sent stream (GET and DELETE answer 405). CORS is open to any origin, so browser-based clients can connect.",
            },
            { key: "capabilities", term: "Capabilities", detail: "tools and prompts. No resources." },
            {
              key: "auth",
              term: "Sign-in",
              detail: (
                <>
                  OAuth 2.1 with PKCE (S256) and dynamic client registration, or an API key as{" "}
                  <Code>Authorization: Bearer {KEY}</Code>. Without a credential the server answers 401 with{" "}
                  <Code>WWW-Authenticate</Code> naming its resource metadata:{" "}
                  <Link_ href={PROTECTED_RESOURCE_METADATA_URL}>{PROTECTED_RESOURCE_METADATA_URL}</Link_>
                </>
              ),
            },
            {
              key: "catalogue",
              term: "Tool catalogue",
              detail: (
                <>
                  Every tool with its JSON Schemas, public, no key needed: <Link_ href={TOOLS_URL}>{TOOLS_URL}</Link_>
                </>
              ),
            },
          ]}
        />
      </Section>

      <Section id="plan" title="Plan required">
        <P>
          Using GTF through MCP, or through its API, needs an active plan on your GetTrafficFast account. Plans and
          prices are on the <Link_ href={PRICING_URL}>pricing page</Link_>. No account yet? Signing in while you connect
          offers to create one.
        </P>
        <P>Without an active plan (none yet, ended, cancelled or unpaid):</P>
        <Bullets>
          <li>You can still connect: the sign-in and consent screens work, and the consent screen says the account has no active plan.</li>
          <li>The agent can still start, list the tools and list the prompts, so it can explain what GTF does.</li>
          <li>
            Every tool call answers the same error, whatever the tool: code <Code>subscription_required</Code> (HTTP
            402 on the API), with this message:
          </li>
        </Bullets>
        <blockquote className="rounded-lg border border-border bg-card p-3 text-sm text-foreground">{PLAN_REQUIRED_MESSAGE}</blockquote>
        <P>
          The server&apos;s instructions tell the agent not to retry and to tell you just that. The plan is checked on
          every call, so once it is active the same connection or key works again, with nothing to reconnect.
        </P>
      </Section>

      <Section id="connect-oauth" title="Connect with sign-in">
        <P>For clients that cannot send a header of their own: claude.ai, the Claude apps, ChatGPT and other apps.</P>
        <Sub id="claude-ai" title="claude.ai, Claude Desktop and Claude mobile">
          <Steps>
            <li>
              Open <Place>Customize → Connectors</Place> and choose <Place>Add custom connector</Place>. On a Team or
              Enterprise plan an Owner adds it in Organization settings → Connectors, then each member connects.
            </li>
            <li className="space-y-2">
              <span className="block">Paste the server address. Leave the OAuth client ID and secret empty:</span>
              <CopyText text={MCP_URL} label="Copy the MCP server address" />
              <span className="block">If Claude asks how it identifies itself, choose Register automatically.</span>
            </li>
            <li>
              <Place>Add</Place>, then <Place>Connect</Place>. A GetTrafficFast page opens: sign in, or create an account.
            </li>
            <li>
              Choose what Claude may do. Read and Write are ticked; Spend and Publish only if you tick them. Choose one
              site or all of them: with all, name the site in your message and Claude works on that one (see{" "}
              <a href="#sites" className="text-foreground underline underline-offset-4">
                Several sites
              </a>
              ). Then <Place>Allow</Place>.
            </li>
          </Steps>
          <P>
            Your routine is then in the chat&apos;s <Place>+</Place> menu, under GetTrafficFast (see{" "}
            <a href="#prompts" className="text-foreground underline underline-offset-4">
              Prompts
            </a>
            ).
          </P>
        </Sub>
        <Sub id="chatgpt" title="ChatGPT and other apps">
          <P>
            Any client that connects to a remote MCP server with OAuth works the same way: add a connector with the
            server address above and OAuth sign-in, with no client ID. It registers itself, opens GetTrafficFast&apos;s
            sign-in and the consent screen, and comes back with the permissions you ticked. In ChatGPT, custom MCP
            connectors are offered in developer mode, on the plans that have it. The sign-in follows the MCP
            authorization standard; not every app that implements it has been tried with GTF.
          </P>
        </Sub>
        <Sub id="claude-code-oauth" title="Claude Code, without a key">
          <CopyText text={CLAUDE_CODE_OAUTH} label="Copy the Claude Code command" small />
          <P>
            Then run <Code>/mcp</Code> in Claude Code and sign in. A key (below) stays the simpler way for Claude Code
            and scripts.
          </P>
        </Sub>
        <Sub title="Disconnecting">
          <P>
            <Place>Settings → Claude and API</Place>, Connected apps, Revoke: every token of that connection ends on its
            next use. An access token lasts an hour and is refreshed by the app; a connection unused for 30 days has to
            sign in again. An account has at most {MAX_LIVE_GRANTS} connected apps.
          </P>
        </Sub>
      </Section>

      <Section id="connect-key" title="Connect with a key">
        <P>
          For Claude Code, Cursor, VS Code, scripts and any client that can send a header. Create a key in{" "}
          <Place>Settings → Claude and API</Place>: it gets Read and Write; tick Spend if the agent should draft or
          write, and Publish if it may publish articles. The key is shown once; GTF keeps only its fingerprint. An
          account has at most {MAX_ACTIVE_API_KEYS} active keys.
        </P>
        <Sub id="key-claude-code" title="Claude Code">
          <CopyText text={CLAUDE_CODE_KEY} label="Copy the Claude Code command" small />
        </Sub>
        <Sub id="key-cursor" title="Cursor (mcp.json)">
          <CopyText text={CURSOR} label="Copy the Cursor configuration" small />
        </Sub>
        <Sub id="key-vscode" title="VS Code (.vscode/mcp.json)">
          <CopyText text={VSCODE} label="Copy the VS Code configuration" small />
        </Sub>
        <Sub id="key-generic" title="Any other client">
          <P>
            The server address, transport Streamable HTTP, and the header <Code>Authorization: Bearer {KEY}</Code>. To
            check a key by hand:
          </P>
          <CopyText text={GENERIC} label="Copy the example request" small />
        </Sub>
        <P>
          Replace <Code>{KEY}</Code> with your key. With a key for every site, add the header{" "}
          <Code>x-gtf-business: &lt;site id&gt;</Code> to choose one, or let the agent choose per call with{" "}
          <Code>site</Code>; without either the tools act on the key&apos;s default site (your oldest, until you change
          it), and <Code>whoami</Code> says which. The snippets follow each client&apos;s documented format; check your
          client&apos;s own docs if it has changed.
        </P>
      </Section>

      <Section id="sites" title="Several sites">
        <P>
          A connection or a key covers one site, or all of yours. With all of them, you choose the site in the
          conversation: say &ldquo;run my day for Bravo&rdquo; and the agent works on Bravo. Without a name, the tools
          act on the connection&apos;s default site: your oldest, until you say &ldquo;use Bravo by default&rdquo;.
        </P>
        <Bullets>
          <li>
            Every tool that acts on a site takes an optional <Code>site</Code>: the site&apos;s name, its domain or its
            id, case does not matter. <Code>whoami</Code> and <Code>list_businesses</Code> list the sites the
            connection may use.
          </li>
          <li>
            A name that matches two sites, or none, is refused with the list of your sites, so the agent can ask you.
            A connection or a key for one site can never reach another.
          </li>
          <li>
            To change the default, tell the agent: it calls <Code>set_default_site</Code> (a name, domain or id, or{" "}
            <Code>null</Code> for the oldest again), saved on that connection or key for the next chats too. Or
            change it in <Place>Settings → Claude and API</Place>, next to the connection or the key. A site you name
            in a request still wins for that request.
          </li>
          <li>
            The prompts take <Code>site</Code> too. Without it, a connection that covers several sites uses its saved
            default, or asks you which one first when none is saved.
          </li>
        </Bullets>
      </Section>

      <Section id="permissions" title="Permissions">
        <P>Each key or connection has the permissions you ticked. A tool needs its own; a paid tool also needs Spend.</P>
        <Rows
          rows={SCOPE_COPY.map((scope) => ({
            key: scope.id,
            term: (
              <>
                {scope.label} <Code>{scope.id}</Code>
              </>
            ),
            detail: scope.detail,
          }))}
        />
        <P>
          A key or connection without a permission does not see the tools that need it in <Code>tools/list</Code>, and
          calling one answers <Code>forbidden_scope</Code>. Turning on Autopilot needs Spend and Publish; turning on
          scheduled AI checks or images needs Spend.
        </P>
      </Section>

      <Section id="prompts" title="Prompts">
        <P>
          Two prompts walk the agent through your routine, one step at a time, under the same rules as the screens. A
          prompt calls nothing by itself; the agent calls the tools as you go, and asks before anything that spends.
        </P>
        <Rows
          rows={PROMPTS.map((prompt) => ({
            key: prompt.name,
            term: <Code>{prompt.name}</Code>,
            detail: (
              <>
                <Strong>{prompt.title}.</Strong> {prompt.description}
                {prompt.arguments.length > 0 ? ` Optional: ${prompt.arguments.map((arg) => arg.name).join(", ")}.` : ""}
              </>
            ),
          }))}
        />
        <Bullets>
          <li>
            <Strong>claude.ai and the Claude apps:</Strong> in a chat, the <Place>+</Place> menu, GetTrafficFast, then
            the prompt.
          </li>
          <li className="space-y-2">
            <span className="block">
              <Strong>Claude Code:</Strong> a slash command, its arguments after it:
            </span>
            <CopyText text={ROUTINE_COMMAND} label="Copy the Claude Code command" small />
          </li>
          <li>
            <Strong>VS Code and other clients:</Strong> where the client supports MCP prompts, they are listed under
            the server&apos;s name (in VS Code, type <Code>/</Code> in chat). Where it does not, ask in words: &ldquo;run my
            day in GetTrafficFast&rdquo;. The tools are the same.
          </li>
        </Bullets>
      </Section>

      <Section id="tools" title="Tools">
        <P>
          {toolCount} tools today, listed from the same registry the server runs, by the part of the product they work
          on. The full descriptions and schemas are at <Link_ href={TOOLS_URL}>{TOOLS_URL}</Link_>.
        </P>
        <Bullets>
          <li>
            <Badge>read-only</Badge> reads only (MCP <Code>readOnlyHint</Code>).
          </li>
          <li>
            <Badge tone="warn">destructive</Badge> deletes your data, so a client asks first (<Code>destructiveHint</Code>).
          </li>
          <li>
            <Badge>paid</Badge> starts AI work included in your plan: needs Spend, counts against the daily limits.
          </li>
          <li>
            <Badge>publishes</Badge> reaches your own live site: needs Publish and <Code>confirm: true</Code> (
            <Code>openWorldHint</Code>).
          </li>
        </Bullets>
        <div className="space-y-3">
          {areas.map((area) => (
            <details key={area.id} id={`tools-${area.id}`} className="group overflow-hidden rounded-lg border border-border bg-card">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {area.title} <span className="text-sm font-normal text-muted-foreground">· {area.tools.length}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{area.note}</span>
                </span>
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              <ul className="divide-y divide-border border-t border-border">
                {area.tools.map((tool) => (
                  <li key={tool.name} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                    <code className="font-mono text-[13px] text-foreground break-all sm:w-64 sm:shrink-0">{tool.name}</code>
                    <span className="flex flex-wrap items-baseline gap-1.5 text-sm text-muted-foreground">
                      <span>{tool.title}</span>
                      {tool.readOnly ? <Badge>read-only</Badge> : null}
                      {tool.destructive ? <Badge tone="warn">destructive</Badge> : null}
                      {tool.paid ? <Badge>paid</Badge> : null}
                      {tool.publishes ? <Badge>publishes</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </Section>

      <Section id="limits" title="Limits">
        <Bullets>
          <li>{limits.perMinute} calls a minute per key or connected app, whatever the tool.</li>
          <li>
            Daily caps on paid tools, per key and for the whole account (screens included):{" "}
            {limits.daily.map((entry, index) => (
              <span key={entry.label}>
                <Code>{entry.label}</Code> {entry.cap}
                {index < limits.daily.length - 1 ? ", " : ""}
              </span>
            ))}
            .
          </li>
          <li>
            Per account: {limits.drafts} reply drafts and {limits.corrections} fixes a day, and one article a day on each
            site&rsquo;s calendar.
          </li>
          <li>
            A daily limit on AI work overall, so nothing runs away. When it is reached, tools that start AI work answer{" "}
            <Code>spend_cap_reached</Code> with when it resets; queued work waits and goes on by itself.
          </li>
          <li>Caps count a rolling 24 hours and open up again within a day.</li>
          <li>
            <Code>get_plan_usage</Code> shows each limit and what is used, as Settings → Billing does. Nothing is billed
            per call.
          </li>
        </Bullets>
      </Section>

      <Section id="errors" title="Errors">
        <P>
          A refused call is an MCP tool result with <Code>isError: true</Code> whose text is{" "}
          <Code>{`{ "error": { "code", "message", "hint" } }`}</Code>; on the API, the same object with the status
          below. The code is stable: branch on it. The message is a sentence to show a person; the hint, when there is
          one, says what to do next.
        </P>
        <Rows
          rows={Object.entries(ERROR_CODE_DOCS).map(([code, doc]) => ({
            key: code,
            term: (
              <>
                <Code>{code}</Code> <span className="font-normal text-muted-foreground">{doc.status}</span>
              </>
            ),
            detail: doc.meaning,
          }))}
        />
        <P>
          An unknown prompt or a prompt argument out of range is JSON-RPC error <Code>-32602</Code> (Invalid params).
        </P>
      </Section>

      <Section id="never" title="What GTF never does">
        <Callout title="Through MCP, as on the screens">
          <Bullets>
            <li>Never posts on its own, and never on Reddit or any social site but X. The agent hands you the link that opens X with the reply typed in; you post it.</li>
            <li>
              Never publishes without the Publish permission. <Code>publish_article</Code> is the only tool that writes
              to your own site, and <Code>post_on_x</Code> the only one that posts on X (from the X account you
              connected for the site, to a post that mentions or quotes it, or a post of the account&apos;s own); both
              also need <Code>confirm: true</Code>.
            </li>
            <li>Never starts AI work without the Spend permission, and never switches spending on (Autopilot, images, scheduled checks) without <Code>confirm: true</Code>: the agent asks you first.</li>
            <li>Never reaches another account&apos;s data, or a site the key or connection is not for.</li>
            <li>Never creates or revokes keys, and never handles a password or a secret: connecting WordPress or a webhook is done signed in.</li>
          </Bullets>
        </Callout>
      </Section>

      <Section id="privacy" title="Privacy and data">
        <Bullets>
          <li>The agent sees only what your account holds, for the site it is connected to, through the same checks as the screens.</li>
          <li>
            Each call is logged for {TOOL_CALLS_RETENTION_DAYS} days: the tool, the outcome, how long it took, what it
            measurably cost, and which key or app made it. Not the input or the output. The log is what the limits count.
          </li>
          <li>Keys, access tokens and refresh tokens are stored only as fingerprints (hashes), never in the clear.</li>
          <li>
            The rest is in the{" "}
            <Link href="/privacy-policy#api-and-mcp" className="text-foreground underline underline-offset-4">
              privacy policy
            </Link>{" "}
            and the{" "}
            <Link href="/terms-and-conditions" className="text-foreground underline underline-offset-4">
              terms
            </Link>
            .
          </li>
        </Bullets>
      </Section>

      <Section id="support" title="Support">
        <P>
          Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4 break-all">
            {CONTACT_EMAIL}
          </a>
          . The rest of the docs, how GTF works and how it measures, are at{" "}
          <Link href="/docs" className="text-foreground underline underline-offset-4">
            {SITE_URL}/docs
          </Link>
          .
        </P>
      </Section>
    </div>
  );
}

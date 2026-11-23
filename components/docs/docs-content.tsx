import Link from "next/link";
import { CONTACT_EMAIL, OPERATOR_NAME, SITE_SUMMARY, SITE_URL } from "@/lib/site";
import { SCOPE_COPY } from "@/components/settings/scope-copy";
import { engineSentence, type AnswerEngine } from "@/components/landing/engines";
import { CopyText } from "./copy-text";
import type { DocToolGroup } from "./tool-groups";
import { PROMPTS } from "@/lib/tools/prompts";
import { DOC_SECTIONS } from "./sections";
import { AI_ANSWER_CRAWLERS, AI_TRAINING_CRAWLERS, wordpressRobotsSnippet } from "@/lib/ai-crawlers";

/**
 * The public documentation (`/docs`): how GetTrafficFast works, what its
 * numbers mean, how to run it from Claude. It replaced the in-app Help and
 * Contact pages on 2026-11-14, so it is written for a customer first and
 * readable by an agent (plain headings, anchors, no script needed).
 *
 * Every sentence has to be true of the code. The numbers it states come
 * from where the code keeps them (the tools from the registry, the limits
 * from TOOL_LIMITS and the daily caps, the engines from the providers
 * switched on), handed in by the page. Nothing about GetTrafficFast's own
 * results is quoted here (the owner's rule, 2026-11-12).
 */

export { DOC_SECTIONS };

export interface DocsLimits {
  perMinute: number;
  /** Paid tools with a daily cap, per key and per account. */
  daily: ReadonlyArray<{ label: string; cap: number }>;
  drafts: number;
  corrections: number;
}

export interface DocsContentProps {
  engines: readonly AnswerEngine[];
  toolGroups: readonly DocToolGroup[];
  limits: DocsLimits;
}

const MCP_URL = `${SITE_URL}/api/mcp`;
const TOOLS_URL = `${SITE_URL}/api/v1/tools`;
/** Claude Code names an MCP prompt `/mcp__<server>__<prompt>`; the server is added as gettrafficfast above. */
const ROUTINE_COMMAND = "/mcp__gettrafficfast__daily_routine Europe/Berlin";
const CLAUDE_CODE = `claude mcp add --transport http gettrafficfast ${MCP_URL} --header "Authorization: Bearer gtf_…"`;
const CURL = `curl -X POST ${TOOLS_URL}/list_reply_inbox \\
  -H "Authorization: Bearer gtf_…" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"open","limit":10}'`;

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-4">
      <h2 id={`${id}-title`} className="text-2xl font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Sub({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-6 space-y-3">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

export function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

export function Bullets({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 text-muted-foreground marker:text-muted-foreground">{children}</ul>;
}

export function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal space-y-3 pl-5 text-muted-foreground marker:font-semibold marker:text-foreground">{children}</ol>;
}

export function Place({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground break-words">{children}</code>;
}

export function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4">
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  );
}

/** "On this page": a card of 44px links on a phone, a sticky column from `lg` up. */
export function DocsToc({ sections = DOC_SECTIONS }: { sections?: ReadonlyArray<{ id: string; title: string }> } = {}) {
  return (
    <nav aria-label="On this page" className="rounded-lg border border-border bg-card p-2 lg:sticky lg:top-6 lg:border-0 lg:bg-transparent lg:p-0">
      <p className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
      <ul className="grid grid-cols-2 lg:grid-cols-1">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="flex min-h-[44px] items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground lg:min-h-[36px]"
            >
              {section.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocsContent({ engines, toolGroups, limits }: DocsContentProps) {
  const toolCount = toolGroups.reduce((sum, group) => sum + group.tools.length, 0);
  const engineWords = engineSentence(engines);

  return (
    <div className="min-w-0 space-y-14 text-[15px] leading-relaxed">
      <Section id="getting-started" title="Getting started">
        <P>{SITE_SUMMARY}</P>
        <Steps>
          <li>
            <Strong>Add your site.</Strong> In <Place>Settings → Business</Place>, paste your address and tap Analyze
            Website. GTF reads your home page and drafts the niche and the description; check them, then save. The
            address is locked after the first save, because every topic, article and number is made for it. To change
            it, write to us.
          </li>
          <li>
            <Strong>Say what is true about you.</Strong> In <Place>Settings → Voice and facts</Place>, About you is
            what a reply may say about you: with it empty, no reply is drafted. Facts for articles are the only
            first-hand facts an article may state.
          </li>
          <li>
            <Strong>Connect Search Console.</Strong> In <Place>Settings → Connections</Place>, sign in with Google and
            pick your property. GTF only reads. The first pull reaches back 90 days.
          </li>
          <li>
            <Strong>Turn on Find posts on X.</Strong> Same page. Once a day GTF looks on X for fresh posts about your
            topics, and drafts replies to the best ones. If the switch says it is not available yet, searching X is not
            set up on GetTrafficFast.
          </li>
          <li>
            <Strong>Connect your blog</Strong> (optional). WordPress, or a webhook for any other site. Without one,
            copy an article&apos;s HTML or Markdown and paste it wherever you publish.
          </li>
        </Steps>

        <Sub id="every-day" title="What GTF does on its own">
          <P>Times are UTC.</P>
          <Bullets>
            <li>
              <Strong>Monday, Wednesday, Friday, 10:00.</Strong> Looks for conversations on the web (Reddit, X,
              LinkedIn, GitHub, Hacker News, Quora, Stack Exchange and similar) and judges which are worth answering.
            </li>
            <li>
              <Strong>Every day, 13:20.</Strong> With Find posts on X on, looks for fresh posts on X and drafts replies
              to up to five of the best.
            </li>
            <li>
              <Strong>Every day, 06:00.</Strong> With Autopilot on, keeps the calendar filled ahead and adds topics
              when they run low.
            </li>
            <li>
              <Strong>Every day, 08:00.</Strong> Writes the article of the day, checks it, and publishes it to your
              connected site when it passes.
            </li>
            <li>
              <Strong>Every day.</Strong> Reads Search Console, and the public numbers of your replies on X.
            </li>
            <li>
              <Strong>Weekly or monthly, if you choose.</Strong> Asks the AI answer engines your questions.
            </li>
          </Bullets>
        </Sub>
      </Section>

      <Section id="today" title="Your day in GTF">
        <P>Today is one list of the things that need a gesture from you. Do one and it leaves the list.</P>
        <Bullets>
          <li>
            <Strong>Replies.</Strong> The posts and threads worth answering, best first, each with a draft in your
            voice. Read it. Fix it says what is wrong, and the draft is rewritten once. Reply on X opens X with the
            draft typed in; anywhere else, copy it and open the thread. You post it, then tap I posted it.
          </li>
          <li>
            <Strong>Three views.</Strong> To do is what waits for you. Posted is the replies you posted, with their
            link and their numbers on X. Archive is what you set aside, and you can bring it back.
          </li>
          <li>
            <Strong>Your daily goal.</Strong> &ldquo;3 of 5 today&rdquo; counts the replies you marked as posted
            today. Set the goal in <Place>Settings → Voice and facts</Place>, or leave it empty for a plain count.
          </li>
          <li>
            <Strong>Also today.</Strong> Things that need you once: an article waiting for a fact, an article that
            failed, a sentence in About you that may be out of date. They show only when there is one. An article
            you do not want to deal with now can be ignored there (one at a time, or all at once): it leaves Today
            and stays in Content, where you can still open it. If its state changes later (a new failure, a new
            hold), it shows on Today again.
          </li>
          <li>
            <Strong>The link of your reply.</Strong> On X, with Find posts on X on, GTF finds it by itself 2 minutes,
            15 minutes, 2 hours and 12 hours after you mark the reply as posted. Anywhere else, paste it.
          </li>
        </Bullets>
        <Callout title="Three rules that do not change">
          <Bullets>
            <li>GTF never posts for you. Nothing goes to X, Reddit or anywhere else without your tap.</li>
            <li>A reply names no product and carries no link. The answer is the whole reply.</li>
            <li>
              A reply says only what is true. It speaks from About you, and a claim it cannot ground is refused before
              you see the draft.
            </li>
          </Bullets>
        </Callout>
      </Section>

      <Section id="content" title="Articles and topics">
        <P>Content is your blog: a calendar with one article a day, and the topics coming next.</P>
        <Bullets>
          <li>
            <Strong>One article a day.</Strong> Each topic on the calendar becomes an article on its day: researched
            against the pages that rank now, written for your business, checked, then published to your connected
            site. Without a connected site it stays on the calendar, ready to copy.
          </li>
          <li>
            <Strong>Next topics.</Strong> Ideas from your site&apos;s profile, with search volume and difficulty as a
            model&apos;s estimates, labelled so; and questions people ask in the threads GTF found for you, which
            Autopilot adds by itself, a few a day. Each topic is tagged with the kind of search it answers:
            Comparison, How-to (about a tool your audience uses), Problem, or Core topic. Autopilot aims each week
            for one or two comparisons, two how-tos and two or three problem pieces when the pool has them, and a
            comparison only ever names products your own site&apos;s data names. Two topics that overlap are never
            both scheduled.
          </li>
          <li>
            <Strong>Autopilot</Strong> is off until you turn it on in <Place>Settings → Autopilot</Place>. It keeps
            the calendar filled ahead (14 days unless you choose another number) and adds topics when fewer than 10
            are left. That buffer is your review window: an article sits on the calendar for those days before it is
            written, so you can remove it first. With Autopilot on, GTF writes and publishes without asking each time.
          </li>
          <li>
            <Strong>Images.</Strong> Off until you turn them on, in <Place>Settings → Autopilot</Place>, under Images
            and video: a generated featured image for every new article, and up to three more in the text if you
            choose.
          </li>
        </Bullets>

        <Sub id="article-waiting" title="Why an article can wait for you">
          <P>An article is held, not published, only for a problem that can be checked:</P>
          <Bullets>
            <li>a fact or a number that is in neither the research nor your Facts for articles;</li>
            <li>a wrong or broken link;</li>
            <li>a factual error against the research or your facts;</li>
            <li>unsafe content.</li>
          </Bullets>
          <P>
            A matter of taste never holds an article. The hold says why. Add the missing fact to Facts for articles,
            or regenerate the article, then publish it.
          </P>
        </Sub>

        <Sub id="ai-crawlers" title="Be readable by AI answer engines">
          <P>
            An answer engine can only cite a page its crawler may read, and your robots.txt decides that. Two kinds of
            crawler matter:
          </P>
          <Bullets>
            <li>
              <Strong>Search and answer crawlers</Strong> ({AI_ANSWER_CRAWLERS.join(", ")}) read a page so an engine
              can find it, or fetch it when someone asks about it. Blocking them keeps you out of that engine&apos;s
              answers.
            </li>
            <li>
              <Strong>Training crawlers</Strong> ({AI_TRAINING_CRAWLERS.join(", ")}) decide whether your pages may be
              used to train models. Blocking them does not remove you from search; allowing them is your call.
              Google-Extended also covers grounding answers in Google&apos;s Gemini apps.
            </li>
          </Bullets>
          <P>
            <Strong>On WordPress</Strong>, add these lines to your robots.txt: in your SEO plugin&apos;s robots.txt
            editor (Yoast SEO and Rank Math both have one), or in a robots.txt file at the root of your site. They
            repeat WordPress&apos;s own rule for <Code>/wp-admin/</Code>, because a crawler named in a group of its own
            stops reading the rules written for every crawler (<Code>User-agent: *</Code>).
          </P>
          <CopyText text={wordpressRobotsSnippet()} label="Copy the robots.txt lines" small />
          <P>
            <Strong>llms.txt</Strong> is a plain-text list of your main pages at <Code>/llms.txt</Code>, for language
            models. It is a proposal, not a standard: no engine promises to read it. On WordPress, recent versions of
            Yoast SEO and Rank Math can generate one from your published posts, which beats a file written once and
            never updated. A site that receives articles by webhook can serve one too: the prompt in{" "}
            <Place>Settings → Connections → Webhook</Place> asks your coding agent for both.
          </P>
          <P>
            These lines help crawlers find and read your pages. They do not make an engine cite you, and GTF cannot
            tell you that they did: no engine says why it cited a page, and whether you are cited is sampled, see{" "}
            <a href="#ai-answers" className="text-foreground underline underline-offset-4">
              AI answers, sampled
            </a>
            .
          </P>
        </Sub>
      </Section>

      <Section id="growth" title="Growth">
        <P>
          Growth puts this week next to the week before: your replies on X, Google, and AI answers. Each number says
          where it comes from.
        </P>
      </Section>

      <Section id="how-we-measure" title="How we measure">
        <P>A number GTF has not measured reads &ldquo;not measured&rdquo;, never 0. Zero means it was measured and was zero.</P>
        <Sub title="Google">
          <Bullets>
            <li>
              Clicks and impressions come from Search Console: counted by Google, not estimated. GTF reads them every
              day and matches each page to your article by its address; a page it cannot match is left out, never
              guessed.
            </li>
            <li>
              Google settles each day over about three days, so the newest days arrive late. A day not settled yet is
              missing, not zero.
            </li>
            <li>
              Positions are Google&apos;s average from Search Console, weighted by impressions, to one decimal. Without
              Search Console, a position GTF read from a results page itself, marked as such. The two are never mixed
              in one line.
            </li>
            <li>
              Pages on Google come from Google&apos;s URL Inspection, in Google&apos;s own words. A page never checked
              is &ldquo;not checked&rdquo;, never &ldquo;not indexed&rdquo;.
            </li>
          </Bullets>
        </Sub>
        <Sub title="X">
          <Bullets>
            <li>
              Views, likes, replies and reposts are X&apos;s public counters for your posted replies, read once a day
              for the 14 days after posting, for replies whose link is known.
            </li>
            <li>
              They are running totals. This week&apos;s views are the views so far of the replies you posted this
              week, not the views that happened this week. Last week is read as of its own last day, so the two weeks
              compare replies of the same age.
            </li>
            <li>
              Followers are your X account&apos;s, read once a day. X&apos;s public numbers have no profile visits, so
              GTF has none either.
            </li>
          </Bullets>
        </Sub>
        <Sub id="ai-answers" title="AI answers, sampled">
          <P>
            No answer engine says whether it cited you, so GTF samples. On each run it asks each engine your questions,
            once each and up to the number per run you set, and looks for your site among the sources each answer
            returned.{" "}
            {engineWords ? `The engines asked today: ${engineWords}.` : "No answer engine is switched on right now, so nothing is asked."}
          </P>
          <Bullets>
            <li>Per engine, never averaged: engines disagree, and an average describes nothing.</li>
            <li>Under 10 readable answers, a count (&ldquo;2 of 7&rdquo;), not a percent.</li>
            <li>An answer that could not be read is left out, not counted as &ldquo;not cited&rdquo;.</li>
            <li>Not measured means GTF has not asked yet. 0 means it asked and you were not cited.</li>
            <li>Two runs are compared only when they asked the same questions of the same engines.</li>
            <li>Runs are off until you choose weekly or monthly, or tap Run now.</li>
            <li>The pages the answers cited instead of you can become places to reply, in Today.</li>
          </Bullets>
          <P>
            Not shown: engines GTF does not ask (ChatGPT, Claude, Copilot, AI Overviews), sentiment, and a single
            &ldquo;visibility score&rdquo;.
          </P>
        </Sub>
      </Section>

      <Section id="claude" title="Use GTF from Claude">
        <P>
          Everything you can do on these screens is also a tool Claude can call, through MCP: the same checks, your
          sites only. Ask for what you would do here: &ldquo;what should I reply to today?&rdquo;, &ldquo;draft a reply
          to this post&rdquo;, &ldquo;how did last week go?&rdquo;.
        </P>
        <P>
          The full MCP reference, for any client (Claude, ChatGPT, Cursor, VS Code, your own), with every tool, the
          permissions, the limits and the error codes, is at{" "}
          <Link href="/docs/mcp" className="text-foreground underline underline-offset-4">
            {SITE_URL}/docs/mcp
          </Link>
          . Using GTF through MCP needs an active plan on your account.
        </P>
        <Sub id="claude-app" title="On claude.ai, the desktop app or your phone (no key)">
          <Steps>
            <li>
              In Claude, open <Place>Customize → Connectors</Place> and choose <Place>Add custom connector</Place>. On a
              Team or Enterprise plan an Owner adds it in Organization settings → Connectors, then each member
              connects.
            </li>
            <li className="space-y-2">
              <span className="block">Paste this address. Leave the OAuth client ID and secret empty:</span>
              <CopyText text={MCP_URL} label="Copy the MCP address" />
              <span className="block">If Claude asks how it identifies itself, choose Register automatically.</span>
            </li>
            <li>
              <Place>Add</Place>, then <Place>Connect</Place>. Sign in to GetTrafficFast if asked.
            </li>
            <li>
              Choose what Claude may do: Read and Write are ticked; Spend and Publish only if you tick them. Choose
              the site: with all your sites, Claude acts on your oldest one. Then <Place>Allow</Place>.
            </li>
          </Steps>
          <P>
            To disconnect it: <Place>Settings → Claude and API</Place>, Connected apps, Revoke.
          </P>
        </Sub>
        <Sub id="claude-code" title="In Claude Code (with a key)">
          <Steps>
            <li>
              In <Place>Settings → Claude and API</Place>, create a key. Tick Spend if Claude should draft replies or
              write articles. Copy it: it is shown once.
            </li>
            <li className="space-y-2">
              <span className="block">Run this, with your key in place of gtf_…:</span>
              <CopyText text={CLAUDE_CODE} label="Copy the Claude Code command" small />
              <span className="block">
                With a key for every site, add <Code>--header &quot;x-gtf-business: &lt;site id&gt;&quot;</Code> to
                choose one.
              </span>
            </li>
          </Steps>
        </Sub>
        <Sub id="routine" title="Run your day from Claude">
          <P>
            Two ready-made prompts walk Claude through your routine, one step at a time, with the same rules as the
            screens. They call the tools only as you go, and ask before anything that spends.
          </P>
          <Bullets>
            {PROMPTS.map((prompt) => (
              <li key={prompt.name}>
                <Code>{prompt.name}</Code> <Strong>{prompt.title}.</Strong> {prompt.description}
                {prompt.arguments.length > 0 ? (
                  <>
                    {" "}
                    Optional: {prompt.arguments.map((arg, index) => (
                      <span key={arg.name}>
                        <Code>{arg.name}</Code>
                        {index < prompt.arguments.length - 1 ? ", " : ""}
                      </span>
                    ))}
                    .
                  </>
                ) : null}
              </li>
            ))}
          </Bullets>
          <Steps>
            <li>
              <Strong>On claude.ai and the apps:</Strong> in a chat, open the <Place>+</Place> menu, choose
              GetTrafficFast, then the prompt. If your Claude does not list prompts there, write &ldquo;run my day in
              GetTrafficFast&rdquo;: the tools are the same.
            </li>
            <li className="space-y-2">
              <span className="block">
                <Strong>In Claude Code:</Strong> each prompt is a slash command, its arguments after it:
              </span>
              <CopyText text={ROUTINE_COMMAND} label="Copy the Claude Code command" small />
            </li>
          </Steps>
          <P>
            For each reply, Claude shows the post and the draft and asks: approve, fix or skip. Approve gives you the
            link that opens X with the reply typed in. You post it yourself, then tell Claude, and it marks it as
            posted. Neither GTF nor Claude ever posts.
          </P>
        </Sub>
        <Callout title="What Claude cannot do">
          <Bullets>
            <li>Post on X, Reddit or anywhere else. It hands you the link; you post.</li>
            <li>Create or revoke keys. Only you can, signed in.</li>
            <li>Connect WordPress or a webhook: a password or a secret never passes through a chat.</li>
            <li>
              Start AI work without asking you. Turning on Autopilot, images or scheduled AI checks, and running a
              check now, wait for your yes.
            </li>
          </Bullets>
        </Callout>
      </Section>

      <Section id="tools" title="The tools">
        <P>
          {toolCount} tools today, listed from the same registry the server runs. Each one does what its screen does,
          with the same checks. The full descriptions and schemas are public at{" "}
          <a href={TOOLS_URL} className="text-foreground underline underline-offset-4 break-all">
            {TOOLS_URL}
          </a>
          .
        </P>
        {/* Folded so a phone can scroll past 80 rows; the rows stay in the HTML for readers and agents. */}
        <div className="space-y-3">
          {toolGroups.map((group) => (
            <details key={group.id} className="group overflow-hidden rounded-lg border border-border bg-card">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {group.title} <span className="text-sm font-normal text-muted-foreground">· {group.tools.length}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{group.note}</span>
                </span>
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              <ul className="divide-y divide-border border-t border-border">
                {group.tools.map((tool) => (
                  <li key={tool.name} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                    <code className="font-mono text-[13px] text-foreground break-all sm:w-64 sm:shrink-0">{tool.name}</code>
                    <span className="text-sm text-muted-foreground">{tool.title}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </Section>

      <Section id="api" title="API">
        <P>Every tool is also a plain HTTPS call, for scripts and other agents.</P>
        <Bullets>
          <li>
            <Code>POST {TOOLS_URL}/&lt;name&gt;</Code> runs one tool. The body is its input as JSON; the answer is
            its output as JSON.
          </li>
          <li>
            <Code>GET {TOOLS_URL}</Code> lists every tool, with its permissions and the JSON Schemas of its input and
            output. No key needed.
          </li>
          <li>
            Send <Code>Authorization: Bearer gtf_…</Code>. Keys are made in <Place>Settings → Claude and API</Place>,
            shown once, and kept only as a fingerprint. A key cannot create, list or revoke keys.
          </li>
          <li>
            A key for one site acts on that site. A key for every site acts on your oldest site, unless{" "}
            <Code>x-gtf-business: &lt;site id&gt;</Code> names another, or a call names one with the tools&apos;{" "}
            <Code>site</Code> argument (its name, domain or id); <Code>whoami</Code> says which.
          </li>
          <li>
            An error is <Code>{`{ "error": { "code", "message", "hint" } }`}</Code>. The code is stable: branch on it.
          </li>
        </Bullets>
        <CopyText text={CURL} label="Copy the example call" small />

        <Sub title="Permissions">
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {SCOPE_COPY.map((scope) => (
              <li key={scope.id} className="px-3 py-2 text-sm">
                <span className="font-medium">{scope.label}</span>
                <span className="text-muted-foreground"> · {scope.detail}</span>
              </li>
            ))}
          </ul>
          <P>A new key gets Read and Write. Spend and Publish are yours to tick.</P>
        </Sub>

        <Sub id="limits" title="Limits">
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
              Per account: {limits.drafts} reply drafts and {limits.corrections} fixes a day, and one article a day on
              each site&rsquo;s calendar.
            </li>
            <li>
              A daily limit on AI work overall, so nothing runs away. If you reach it, the screen
              and the API say so and when it resets (<Code>spend_cap_reached</Code>), and queued work waits and goes
              on by itself.
            </li>
            <li>Caps count a rolling 24 hours, and open up again within a day.</li>
            <li>
              Settings → Billing shows each limit and what is used, and so does the <Code>get_plan_usage</Code> tool.
              The plan is a fixed price: nothing here is billed per use.
            </li>
          </Bullets>
        </Sub>
      </Section>

      <Section id="contact" title="Contact">
        <P>
          Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4 break-all">
            {CONTACT_EMAIL}
          </a>
          . There is no form. {OPERATOR_NAME || "The maintainer"} reads it.
        </P>
        <P>
          Not a customer yet? <Link href="/pricing" className="text-foreground underline underline-offset-4">See the plan</Link>.
        </P>
      </Section>
    </div>
  );
}

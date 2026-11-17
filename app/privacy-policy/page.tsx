import Link from "next/link";
import { A, LegalPage, List, type LegalSection } from "@/components/legal/legal-page";
import {
  DISABLED_INTEGRATIONS,
  LEGAL_OPERATOR,
  operatorAddressLine,
  PUBLIC_SOURCES,
  SERVICE_PROVIDERS,
  vatNumberLine,
} from "@/lib/legal";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "@/lib/oauth/config";
import { CONTACT_EMAIL, SITE_URL } from "@/lib/site";
import { TOOL_CALLS_RETENTION_DAYS } from "@/lib/tools/retention";

/**
 * The privacy policy. Every statement is meant to be true of the code and of
 * the production configuration on LEGAL_LAST_UPDATED (lib/legal.ts): the
 * providers come from SERVICE_PROVIDERS, the lifetimes from the constants
 * the code enforces. Change the date with the text.
 */

export const metadata = {
  title: "Privacy Policy - GetTrafficFast",
  description:
    "How GetTrafficFast collects, uses, shares and keeps personal data, who processes it, and how to exercise your rights.",
};

const ACCESS_TOKEN_MINUTES = ACCESS_TOKEN_TTL_MS / 60_000;
const REFRESH_TOKEN_DAYS = REFRESH_TOKEN_TTL_MS / 86_400_000;

function Mail() {
  return <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>;
}

const sections: LegalSection[] = [
  {
    id: "controller",
    title: "Who is responsible for your data",
    body: (
      <>
        <p>
          GetTrafficFast (&quot;GTF&quot;, &quot;we&quot;) is provided by {LEGAL_OPERATOR.name},{" "}
          {LEGAL_OPERATOR.form}, {operatorAddressLine()}. He is the data controller for the personal data described
          here, under the EU General Data Protection Regulation (GDPR) and Italian data protection law.
        </p>
        {vatNumberLine() ? <p>{vatNumberLine()}</p> : null}
        <p>
          Contact for anything about privacy, including exercising your rights: <Mail />. There is no appointed data
          protection officer.
        </p>
        <p>
          This policy covers the website {SITE_URL}, the app, the API and the MCP server. It does not cover your own
          website, where GTF publishes articles you approve: that site has its own policy.
        </p>
      </>
    ),
  },
  {
    id: "data-we-collect",
    title: "The data we collect",
    body: (
      <>
        <p>
          <strong>Account.</strong> Your email address and the sign-in data our authentication provider keeps (when
          you signed in, and, if you use Google sign-in, the name and picture Google shares).
        </p>
        <p>
          <strong>Your sites and their content.</strong> The address of each site you connect, the public pages GTF
          reads from it to understand the business, the keywords, topics, plans, articles, images, drafts and reply
          suggestions GTF produces for you, your edits, and the measurements GTF takes (search rankings, sampled AI
          answers, publishing results).
        </p>
        <p>
          <strong>Voice and facts.</strong> What you write in Settings → Voice: how you write, notes for the writer,
          the facts &quot;About you&quot; that replies may draw on, and the facts articles may state. These are
          personal if you write about yourself; write only what you are happy for GTF to use in drafts.
        </p>
        <p>
          <strong>Publishing connections.</strong> For WordPress, the site address, the username and an application
          password; for webhooks, the address and a shared secret. Passwords and secrets are stored encrypted and are
          never shown back.
        </p>
        <p>
          <strong>Google Search Console, if you connect it.</strong> An access grant (a refresh token, stored
          encrypted) and the data GTF reads with it: for your property, clicks, impressions, average positions and
          the search queries behind them, per page, and the index status of your pages. See{" "}
          <a href="#google-data" className="text-primary underline underline-offset-4">
            Google user data
          </a>
          .
        </p>
        <p>
          <strong>X, if you use it.</strong> Your public X username, the posts you add or reply to, the address of
          your replies, and the public numbers X shows for them and for your account (such as views, likes and
          followers). GTF reads X only through X&apos;s official API and its public embed service. GTF never posts,
          likes or follows on X or anywhere else: you post yourself.
        </p>
        <p>
          <strong>Public posts by other people.</strong> To suggest conversations worth answering, GTF finds and
          stores public posts and threads (on X, Reddit, Hacker News, Stack Exchange, GitHub, DEV, Quora, LinkedIn,
          Indie Hackers and similar sites) that match your site&apos;s topics: the post&apos;s text, its address, its
          author&apos;s public name and username, its date, its public engagement numbers and any images in it. See{" "}
          <a href="#public-posts" className="text-primary underline underline-offset-4">
            People whose public posts GTF reads
          </a>
          .
        </p>
        <p>
          <strong>API, MCP and connected apps.</strong> Your API keys and the apps you connect (such as Claude or
          ChatGPT): their names, scopes and site, and a log of each call. Keys and tokens are stored only as
          fingerprints (SHA-256 hashes). See{" "}
          <a href="#api-and-mcp" className="text-primary underline underline-offset-4">
            API, MCP and connected apps
          </a>
          .
        </p>
        <p>
          <strong>Payments.</strong> Your subscription&apos;s status and its Stripe identifiers. Card details are
          entered on Stripe&apos;s pages and never reach GTF.
        </p>
        <p>
          <strong>Technical data.</strong> Request logs of our hosting provider (IP address, browser, the address
          requested, time), error reports when something fails, and the cost and outcome of the AI work run for your
          account.
        </p>
        <p>
          <strong>Website analytics.</strong> Pages viewed on {SITE_URL}, the referrer, browser and device type and
          an approximate country, measured with DataFast. See{" "}
          <a href="#cookies" className="text-primary underline underline-offset-4">
            Cookies
          </a>
          .
        </p>
        <p>
          <strong>Messages.</strong> What you write to us by email.
        </p>
      </>
    ),
  },
  {
    id: "purposes-and-legal-bases",
    title: "Why we use it, and on what legal basis",
    body: (
      <List>
        <li>
          <strong>Providing the service you signed up for</strong>: running your account and sites, researching,
          writing and publishing content, drafting replies, measuring results, the API and MCP server, billing.
          Legal basis: the contract with you (Art. 6(1)(b) GDPR).
        </li>
        <li>
          <strong>Reading public posts to suggest conversations</strong>, including storing the authors&apos; public
          names and usernames. Legal basis: our and our customers&apos; legitimate interest in finding public
          conversations relevant to a business (Art. 6(1)(f)), limited to what is public and needed to show the
          thread.
        </li>
        <li>
          <strong>Security, abuse prevention, limits, error tracking and keeping the service working.</strong> Legal
          basis: legitimate interest (Art. 6(1)(f)).
        </li>
        <li>
          <strong>Website analytics</strong> on {SITE_URL}, to understand which pages people use. Legal basis:
          legitimate interest (Art. 6(1)(f)); where the law requires consent for the analytics cookie, consent
          (Art. 6(1)(a)).
        </li>
        <li>
          <strong>Connecting Google Search Console or signing in with Google.</strong> These happen only when you
          choose them; you can disconnect at any time. Legal basis: the contract with you.
        </li>
        <li>
          <strong>Service emails</strong> (sign-in links, messages about your account). Legal basis: the contract.
          GTF does not send marketing emails or share your address for marketing.
        </li>
        <li>
          <strong>Invoices and accounting records.</strong> Legal basis: legal obligation (Art. 6(1)(c)).
        </li>
      </List>
    ),
  },
  {
    id: "ai-processing",
    title: "AI processing",
    body: (
      <>
        <p>
          GTF uses AI models from Google (Gemini) and Anthropic (Claude) to analyse your site, plan and write
          articles, generate article images, draft replies and run sampled checks of AI answers. To do a task, GTF
          sends the provider what that task needs: for example your site&apos;s text, your voice settings and facts,
          keywords, a draft, the search queries a page ranks for, or the public post (and its images) a reply
          answers.
        </p>
        <p>
          GTF does not use your content to train AI models. The providers process requests under their own API
          terms and privacy policies, linked under{" "}
          <a href="#service-providers" className="text-primary underline underline-offset-4">
            Service providers
          </a>
          .
        </p>
        <p>
          AI output can be wrong. GTF checks drafts against rules (for example, it refuses figures and claims it
          cannot source), but you review what is published in your name. No decision with legal or similarly
          significant effects on you is made by automated means.
        </p>
      </>
    ),
  },
  {
    id: "google-data",
    title: "Google user data",
    body: (
      <>
        <p>
          If you connect Google Search Console, GTF asks Google for read-only access (the{" "}
          <code>webmasters.readonly</code> scope). GTF never changes anything in your Search Console property. It
          uses the data only to show you your search performance and index status, to measure the articles it
          wrote, and to choose and improve the pages it works on for you (which can mean sending a page&apos;s main
          search query to an AI provider as part of that task).
        </p>
        <p>
          GetTrafficFast&apos;s use and transfer to any other app of information received from Google APIs will
          adhere to the{" "}
          <A href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </A>
          , including the Limited Use requirements. In particular, GTF does not sell this data, does not use it for
          advertising, does not use it to train AI models, and does not let people read it, except with your
          consent, for security, or where the law requires.
        </p>
        <p>
          Disconnecting Search Console in Settings → Connections deletes the stored grant at once. The measurements
          already imported stay in your account as your history until you ask us to delete them or your account is
          deleted. You can also remove GTF&apos;s access from your Google account at{" "}
          <A href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</A>.
        </p>
        <p>
          Articles may embed public YouTube videos found through the YouTube Data API. By using that feature you
          also rely on the <A href="https://www.youtube.com/t/terms">YouTube Terms of Service</A>, and Google
          processes data under the <A href="https://policies.google.com/privacy">Google Privacy Policy</A>.
        </p>
      </>
    ),
  },
  {
    id: "api-and-mcp",
    title: "API, MCP and connected apps",
    body: (
      <>
        <p>
          You can let an AI assistant or a script act on your account with an API key or by connecting an app
          (such as Claude or ChatGPT) through OAuth. You choose the scopes (read, write, spend, publish) and the
          site. The app can then read and change what those scopes allow, for that site, through the same checks as
          the screens. It never reaches another account, never sees passwords or publishing secrets, and cannot
          create or revoke keys.
        </p>
        <p>
          The MCP server receives only the tool calls the app sends, not your conversation with the assistant. What
          the assistant does with the answers is governed by that assistant&apos;s own terms and privacy policy.
        </p>
        <p>
          Each call is logged: which key or app, the tool, the outcome, how long it took and what it measurably
          cost, but not the input or the output. The log is kept {TOOL_CALLS_RETENTION_DAYS} days and then deleted
          automatically.
        </p>
        <p>
          Keys and tokens are stored only as SHA-256 hashes. An access token lasts {ACCESS_TOKEN_MINUTES} minutes; a
          refresh token expires after {REFRESH_TOKEN_DAYS} days without use. You can revoke a key or a connected app
          at any time in Settings → Claude and API; revocation takes effect immediately.
        </p>
      </>
    ),
  },
  {
    id: "public-posts",
    title: "People whose public posts GTF reads",
    body: (
      <>
        <p>
          If you posted publicly on a forum or social network, GTF may have found your post because it matches a
          customer&apos;s topics, and stored its text, address, your public name and username, its date, its public
          numbers and its images, so that the customer can decide whether to answer you. The source is the public
          platform itself (through X&apos;s official API, web search results, and the platforms&apos; public
          interfaces).
        </p>
        <p>
          GTF does not contact you, does not post anything, and does not build profiles of authors. A reply, if any,
          is written and posted by the customer, in their own name. You can object to this processing or ask for
          your posts to be removed by writing to <Mail /> with the addresses of the posts.
        </p>
      </>
    ),
  },
  {
    id: "service-providers",
    title: "Service providers",
    body: (
      <>
        <p>
          GTF does not sell personal data. It shares it only with the providers below, which process it on GTF&apos;s
          behalf to run the service, or as needed for the feature you use:
        </p>
        <List>
          {SERVICE_PROVIDERS.map((provider) => (
            <li key={provider.id}>
              <strong>{provider.name}</strong>: {provider.purpose} Data: {provider.data}{" "}
              <A href={provider.privacyUrl}>Privacy policy</A>.
            </li>
          ))}
        </List>
        <p>
          GTF also reads public data from public platforms ({PUBLIC_SOURCES.map((source) => source.name).join(", ")}
          ), sending them only search terms or the address of a public post.
        </p>
        <p>
          The open-source code also supports{" "}
          {DISABLED_INTEGRATIONS.map((integration) => integration.name).join(", ")}. The hosted service does not use
          them today; this list will be updated before any of them is switched on.
        </p>
        <p>
          We may also disclose data where the law requires it, or to protect our rights, and to a successor if the
          service is transferred, in which case this policy continues to apply.
        </p>
      </>
    ),
  },
  {
    id: "international-transfers",
    title: "International transfers",
    body: (
      <p>
        The database is hosted in the EU (France) and error reports are stored in the EU (Germany). Some providers
        above (for example the AI model providers, the hosting provider, X and Stripe) are established or process
        data outside the European Economic Area, notably in the United States. Where they do, the transfer relies
        on an adequacy decision of the European Commission (such as the EU-US Data Privacy Framework, for providers
        certified under it) or on the Standard Contractual Clauses in the provider&apos;s data processing terms. You
        can ask us for more information at <Mail />.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep data",
    body: (
      <List>
        <li>
          <strong>Account, sites, content, settings and measurements</strong>: as long as your account exists. The
          app has no self-service account deletion yet: write to <Mail /> and we delete the account within 30 days
          of the request. Deleting the account deletes the data linked to it.
        </li>
        <li>
          <strong>Log of API and MCP calls</strong>: {TOOL_CALLS_RETENTION_DAYS} days, deleted automatically every
          day.
        </li>
        <li>
          <strong>API keys and app connections</strong>: kept as hashes while the account exists, so Settings can
          show when a key was revoked. Expired and revoked tokens stop working at once; their hashed records are
          currently kept until the account is deleted.
        </li>
        <li>
          <strong>Search Console grant</strong>: deleted when you disconnect. The imported measurements are kept
          with the account, as above.
        </li>
        <li>
          <strong>Public posts found for a site</strong>: kept while the site is in the account, unless removed
          earlier on request (see above).
        </li>
        <li>
          <strong>Invoices and payment records</strong>: as long as tax and accounting law requires (in Italy,
          generally ten years). Stripe keeps its own records under its policy.
        </li>
        <li>
          <strong>Hosting logs, error reports and website analytics</strong>: for the limited periods set by the
          hosting, error-tracking and analytics providers.
        </li>
        <li>
          <strong>Backups</strong>: deleted data can remain in the database host&apos;s backups until they expire
          on its schedule.
        </li>
        <li>
          <strong>Emails with us</strong>: as long as needed to handle the request and any follow-up.
        </li>
      </List>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        Access to data is restricted per account in the database (row-level security), connections use HTTPS,
        publishing credentials and the Search Console grant are encrypted by GTF before they are stored, and keys
        and tokens are stored only as hashes. The hosting and database providers apply their own security measures.
        No system is perfectly secure; if a breach affects your data, we will notify you and the authority as the
        law requires.
      </p>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights and how to exercise them",
    body: (
      <>
        <p>Under the GDPR you have the right to:</p>
        <List>
          <li>access the personal data we hold about you and get a copy;</li>
          <li>have inaccurate data corrected;</li>
          <li>have data erased;</li>
          <li>restrict processing;</li>
          <li>receive the data you gave us in a portable format (data portability);</li>
          <li>object to processing based on legitimate interest, including the processing of your public posts;</li>
          <li>withdraw consent at any time, where processing relies on it, without affecting what came before.</li>
        </List>
        <p>
          To exercise any of them, write to <Mail /> from the address of your account, or, if you have no account,
          say which data the request is about (for example the addresses of your posts). We may ask you to confirm
          your identity. We answer within one month, as the GDPR requires (extendable by two months for complex
          requests, in which case we tell you). Exercising your rights is free.
        </p>
        <p>
          You also have the right to lodge a complaint with a supervisory authority: in Italy, the{" "}
          <A href="https://www.garanteprivacy.it">Garante per la protezione dei dati personali</A>, or the authority
          of the EU country where you live or work.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies",
    body: (
      <>
        <p>GTF uses a small number of cookies and similar storage:</p>
        <List>
          <li>
            <strong>Necessary</strong>: the sign-in session (set by our authentication provider), the site you have
            selected in the app, and a short-lived security cookie while you connect Google Search Console.
            These are needed for the service and need no consent.
          </li>
          <li>
            <strong>Preferences</strong>: your light or dark theme, stored in your browser.
          </li>
          <li>
            <strong>Analytics</strong>: DataFast sets first-party cookies (a visitor identifier and a session
            identifier) to count visits to {SITE_URL}. GTF does not use advertising cookies.
          </li>
        </List>
        <p>
          You can block or delete cookies in your browser settings; the app needs the necessary ones to keep you
          signed in. In the reply inbox, your browser may load authors&apos; profile pictures from unavatar.io or
          GitHub, which then receive your IP address.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        GTF is a service for businesses and professionals and is not meant for anyone under 18. We do not knowingly
        collect data from children. If you believe a child has given us data, write to <Mail /> and we will delete
        it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        When this policy changes, the new version is published here with a new &quot;Last updated&quot; date. If a
        change materially affects how your data is used, we will tell account holders by email or in the app before
        it takes effect. The{" "}
        <Link href="/terms-and-conditions" className="text-primary underline underline-offset-4">
          terms and conditions
        </Link>{" "}
        govern the use of the service.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        {LEGAL_OPERATOR.name}, {operatorAddressLine()}. Email: <Mail />.
      </p>
    ),
  },
];

export default function PrivacyPolicy() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what personal data GetTrafficFast collects, why, who it is shared with, how long it
          is kept, and how you can exercise your rights. It applies to customers, to visitors of the website, and to
          people whose public posts the service reads.
        </p>
      }
      sections={sections}
    />
  );
}

import Link from "next/link";
import { A, LegalPage, List, type LegalSection } from "@/components/legal/legal-page";
import { LEGAL_OPERATOR, operatorAddressLine, vatNumberLine } from "@/lib/legal";
import { CONTACT_EMAIL, SITE_URL } from "@/lib/site";

/**
 * The terms and conditions. They describe the service as the code runs it
 * on LEGAL_LAST_UPDATED (lib/legal.ts); no prices (the pricing page holds
 * them). Change the date with the text.
 */

export const metadata = {
  title: "Terms and Conditions - GetTrafficFast",
  description:
    "The terms for using GetTrafficFast: the service, accounts, billing, acceptable use, API and MCP access, AI output, liability and governing law.",
};

function Mail() {
  return <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>;
}

function In({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-primary underline underline-offset-4">
      {children}
    </Link>
  );
}

const sections: LegalSection[] = [
  {
    id: "provider",
    title: "Who provides the service",
    body: (
      <>
        <p>
          GetTrafficFast (&quot;GTF&quot;, &quot;we&quot;, the &quot;Service&quot;) is provided by{" "}
          {LEGAL_OPERATOR.name}, {LEGAL_OPERATOR.form}, {operatorAddressLine()}.
        </p>
        {vatNumberLine() ? <p>{vatNumberLine()}</p> : null}
        <p>
          Contact: <Mail />.
        </p>
      </>
    ),
  },
  {
    id: "agreement",
    title: "Agreement to these terms",
    body: (
      <p>
        By creating an account or using the Service, including through the API or the MCP server, you agree to these
        terms and to the <In href="/privacy-policy">privacy policy</In>. If you use the Service for a company, you
        confirm you may bind it, and &quot;you&quot; means that company. If you do not agree, do not use the
        Service.
      </p>
    ),
  },
  {
    id: "the-service",
    title: "The Service",
    body: (
      <>
        <p>
          GTF is a content operating system that helps a business be found on search engines and in AI answers. You
          connect a site; GTF researches it, plans and writes articles, finds public conversations worth answering,
          drafts replies in your voice, publishes articles to the destination you connect, and measures results. In
          particular:
        </p>
        <List>
          <li>
            <strong>Replies are drafts.</strong> GTF suggests replies for a person to review and post. GTF never posts
            on its own, and never likes, follows or messages on X, Reddit or any other platform, in your name or its
            own. The one exception is X, when you connect the X account a site posts from: GTF then posts on X from
            that account only when you press Post (or confirm the post to your AI agent), and you are responsible for
            what you post, as with anything you post yourself. Replies to people who did not mention you still open
            in X for you to post.
          </li>
          <li>
            <strong>Articles are published only to destinations you connect</strong> (for example WordPress or a
            webhook on your site), when you publish them or, with Autopilot on (the default once a destination is
            connected; you can turn it off in Settings), automatically on their scheduled day.
          </li>
          <li>
            <strong>Measurements are sampled.</strong> Rankings and AI-answer citations are measured by sampling;
            no answer engine exposes whether a site was cited, and the figures are estimates, labelled as such.
          </li>
          <li>
            <strong>API and MCP.</strong> You can use the Service from your own scripts and AI assistants through
            the API and the MCP server, as described in the <In href="/docs/mcp">MCP documentation</In>.
          </li>
        </List>
        <p>
          The Service changes over time. We may add, change or remove features; we will not remove a core feature
          you are paying for without telling you in advance.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts",
    body: (
      <List>
        <li>You must be at least 18 years old and give accurate information.</li>
        <li>
          You are responsible for your account, the credentials you connect, and everything done with your account,
          your API keys and the apps you connect.
        </li>
        <li>
          Tell us at once at <Mail /> if you suspect unauthorised use, and revoke the affected keys or connections.
        </li>
        <li>You may connect only sites, accounts and properties you own or are authorised to manage.</li>
      </List>
    ),
  },
  {
    id: "billing",
    title: "Subscription and billing",
    body: (
      <>
        <p>
          The Service is offered on a subscription. Plans, prices, any free trial and what each plan includes are
          shown on the <In href="/pricing">pricing page</In> and at checkout, which form part of these terms.
          Payments are processed by Stripe; GTF never receives your card details.
        </p>
        <List>
          <li>A subscription renews automatically for each billing period until cancelled.</li>
          <li>
            You can cancel at any time in Settings → Billing (the Stripe billing portal). Cancellation takes effect at
            the end of the current billing period, and you keep access until then.
          </li>
          <li>
            Fees already paid are not refunded, except where the law requires it or we decide otherwise.
          </li>
          <li>
            We may change prices. A new price applies to an existing subscription only from a renewal after we have
            told you at least 30 days in advance; you can cancel before it applies.
          </li>
          <li>
            Usage limits and caps described in the Service and the documentation apply to every plan, to keep costs
            bounded and the Service fair.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to use the Service to:</p>
        <List>
          <li>break any law or anyone&apos;s rights, including intellectual property and privacy rights;</li>
          <li>publish content that is defamatory, deceptive, hateful, obscene or harmful;</li>
          <li>
            send spam: mass, repetitive or off-topic replies, undisclosed promotion, fake accounts or coordinated
            inauthentic behaviour;
          </li>
          <li>
            automate posting on X or other platforms with what GTF drafts, or in any way breach the terms and rules of
            the platforms where you post (X, Reddit, forums and others): those rules apply to you;
          </li>
          <li>impersonate someone, or present GTF output as written by someone who did not write or approve it;</li>
          <li>
            attack, probe, overload or circumvent the Service&apos;s limits and security, or access another
            account&apos;s data;
          </li>
          <li>resell or sublicense access to the hosted Service without our written agreement.</li>
        </List>
        <p>
          We may remove content, limit features, or suspend an account that breaks these rules, as described under{" "}
          <a href="#termination" className="text-primary underline underline-offset-4">
            Suspension and termination
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "api-and-automated-access",
    title: "API keys, MCP and connected apps",
    body: (
      <>
        <p>
          Automated access to the Service is allowed through the API and the MCP server, with an API key you create
          or an app you connect through OAuth (for example Claude or ChatGPT). Creating a key or approving a
          connection is your authorisation for that key or app to act on your account, within the scopes and site
          you chose, including actions that cost money (the &quot;spend&quot; scope) or publish to your site (the
          &quot;publish&quot; scope). What it does is treated as done by you.
        </p>
        <List>
          <li>Keep keys secret. Revoke a key or connection in Settings → Claude and API when you no longer need it.</li>
          <li>Calls are rate-limited and capped as described in the documentation; do not try to get around this.</li>
          <li>
            The assistant you connect is a third-party product under its own terms; we are not responsible for what
            it decides to do with the access you give it.
          </li>
          <li>Any other automated access (scraping, bots against the screens) is not allowed.</li>
        </List>
      </>
    ),
  },
  {
    id: "ai-output",
    title: "AI-generated output",
    body: (
      <>
        <p>
          Articles, images, replies, suggestions and analyses are generated with AI models. They can be inaccurate,
          incomplete, similar to other content, or unsuitable for your situation, even though GTF checks them against
          rules.
        </p>
        <p>
          You are responsible for reviewing output before you publish or post it, for what you publish or post, and
          for the facts you give GTF to use. Do not publish output you have not checked where accuracy matters (for
          example health, legal or financial topics). While Autopilot is on, articles are published on their
          scheduled day without a review each time; each one is on your calendar, where you can read, change or remove
          it, before its day.
        </p>
        <p>
          GTF does not promise rankings, traffic, citations by AI answer engines, or any business result.
        </p>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Your content and intellectual property",
    body: (
      <>
        <p>
          <strong>Your content is yours.</strong> You keep all rights in what you give GTF and, as far as the law
          allows, in the output generated for you. You give us the licence needed to host, process, transmit and
          display it only to provide the Service to you (including sending it to the AI providers listed in the
          privacy policy). We do not use your content to train AI models.
        </p>
        <p>
          <strong>The code.</strong> Where the source code of GetTrafficFast is published as open source, it is
          licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). That licence, not these terms,
          governs your use of the code; these terms govern the hosted Service at {SITE_URL}.
        </p>
        <p>
          <strong>Name and logo.</strong> &quot;GetTrafficFast&quot;, &quot;GTF&quot; and the logo are not licensed
          by the AGPL. You may not use them for a product or service of your own (including a self-hosted copy
          offered to others) in a way that suggests it is ours or endorsed by us.
        </p>
        <p>
          <strong>Feedback.</strong> If you send suggestions, we may use them freely, with no obligation to you.
        </p>
      </>
    ),
  },
  {
    id: "third-party-services",
    title: "Third-party services",
    body: (
      <p>
        The Service works with services we do not control: your website and its host, WordPress, Google Search
        Console, X, Stripe, AI model providers and others. Their availability, changes and terms are outside our
        control; when one of them fails or changes, the related feature may stop working.
      </p>
    ),
  },
  {
    id: "availability",
    title: "Availability",
    body: (
      <p>
        We work to keep the Service available and reliable, but it is provided without a guaranteed uptime. It may be
        interrupted for maintenance, updates or reasons beyond our control. Keep your own copies of content that
        matters to you; your published articles live on your own site.
      </p>
    ),
  },
  {
    id: "warranty",
    title: "Warranty disclaimer",
    body: (
      <p>
        To the extent the law allows, the Service is provided &quot;as is&quot; and &quot;as available&quot;,
        without warranties of any kind beyond those the law makes mandatory. This does not exclude or limit any
        right you have as a consumer that cannot be excluded or limited by contract.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <p>
          Nothing in these terms excludes or limits liability for intentional misconduct (dolo) or gross negligence
          (colpa grave), for death or personal injury, or any other liability that cannot be excluded or limited
          under applicable law (including Article 1229 of the Italian Civil Code and consumer protection law).
        </p>
        <p>
          Subject to that, and if you use the Service for business purposes: we are not liable for indirect or
          consequential loss, loss of profit, revenue, traffic or rankings, or for content you published, and our
          total liability arising from the Service in any 12 months is limited to the fees you paid us in those 12
          months.
        </p>
        <p>
          If you are a consumer, we are liable under the applicable law for foreseeable loss caused by our breach of
          these terms.
        </p>
      </>
    ),
  },
  {
    id: "indemnity",
    title: "Your responsibility to us",
    body: (
      <p>
        If you use the Service for business purposes, you will cover our reasonable costs and losses from claims by
        third parties arising from content you published or posted, or from your breach of these terms or of a
        platform&apos;s rules, except to the extent we caused them.
      </p>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <p>
          You can stop using the Service and cancel your subscription at any time, and ask us to delete your account
          by writing to <Mail />.
        </p>
        <p>
          We may suspend or close an account that seriously or repeatedly breaks these terms, puts the Service or
          others at risk, or does not pay. Except where the breach is serious or the law requires immediate action,
          we will tell you first and give you a reasonable chance to fix it. If we close the Service or your account
          without a fault of yours, we will refund the unused part of a prepaid period.
        </p>
        <p>
          What happens to your data after closing is described in the{" "}
          <In href="/privacy-policy#retention">privacy policy</In>. Sections that by their nature should survive
          (intellectual property, liability, governing law) survive termination.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms. The new version is published here with a new &quot;Last updated&quot; date. For
        material changes we will tell account holders by email or in the app at least 30 days before they apply; if
        you do not agree, you can cancel before then. Continuing to use the Service after the changes apply means you
        accept them.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    body: (
      <>
        <p>
          These terms are governed by Italian law. The courts of Rome, Italy, have exclusive jurisdiction over any
          dispute arising from them.
        </p>
        <p>
          If you are a consumer, you keep the protection of the mandatory rules of the country where you live, and
          you can bring proceedings, and must be sued, in the courts of the place where you live (for consumers
          in Italy, as the Italian Consumer Code provides).
        </p>
      </>
    ),
  },
  {
    id: "general",
    title: "General",
    body: (
      <p>
        If a provision of these terms is invalid, the rest stays in force. Not enforcing a provision is not a waiver
        of it. You may not transfer your account or these terms without our consent; we may transfer them to a
        successor of the Service, who will be bound by them. These terms, the pricing and checkout pages and the
        privacy policy are the whole agreement about the Service. The English text is the binding one.
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

export default function TermsAndConditions() {
  return (
    <LegalPage
      title="Terms and Conditions"
      intro={
        <p>
          These terms govern your use of GetTrafficFast: the website, the app, the API and the MCP server. Please
          read them together with the <In href="/privacy-policy">privacy policy</In>.
        </p>
      }
      sections={sections}
    />
  );
}

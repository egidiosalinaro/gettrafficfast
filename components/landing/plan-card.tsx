import type { ReactNode } from "react";
import { engineName, engineSentence, type AnswerEngine } from "@/components/landing/engines";

/**
 * The one plan, in one place.
 *
 * The landing section and /pricing used to carry two hand-maintained copies of
 * this block, which is how they ended up advertising features the product does
 * not have. There is a single price and a single feature list; the only thing
 * that differs between the two pages is the button, so that is the only thing
 * passed in.
 *
 * Every line below is something the product actually does today. A feature
 * that is planned belongs in the roadmap, not on the price card.
 */

export const PLAN_NAME = "Business";
export const PLAN_PRICE_USD = 69;
export const TRIAL_DAYS = 3;

const BASE_FEATURES = [
  "One website",
  "A keyword plan built from your site, with model-estimated volume and difficulty",
  "One article a day from your calendar, planned against the current Google results",
  "Written to a 900 to 1,500 word brief, for your business and in your language",
  "Internal links to your earlier articles, placed automatically",
  "AI images and relevant YouTube videos, when you enable them",
  "Auto-publishing to WordPress, or to any platform via webhook",
  "Autopilot, when you turn it on: keeps the calendar filled so no day goes empty",
  "Reply drafts for posts on X, Reddit and LinkedIn, in your voice. You post them yourself.",
];

const TAIL_FEATURES = [
  "Google rank tracking, and citation checks on the articles that were published",
  "Real clicks and impressions from Google Search Console",
  "Email support, from the person who builds it",
];

/**
 * The feature list for the engines this deployment asks. With none switched
 * on, the line about answer engines is left out rather than promised.
 */
export function planFeatures(engines: readonly AnswerEngine[]): string[] {
  const visibility =
    engines.length > 0
      ? [`Prompt visibility on ${engineSentence(engines)}, sampled, one rate per engine`]
      : [];
  return [...BASE_FEATURES, ...visibility, ...TAIL_FEATURES];
}

export function PlanCard({
  action,
  engines,
  headingLevel = "h3",
}: {
  /** The button: a link on the landing, the real checkout on /pricing. */
  action: ReactNode;
  /** The answer engines this server asks, from `enabledAnswerEngines()`. */
  engines: readonly AnswerEngine[];
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  const features = planFeatures(engines);
  const measured = [...engines.map(engineName), "Google rank", "Search Console"];

  return (
    <div className="bg-card border-2 border-primary rounded-xl p-8 mb-8">
      <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-6">
        <div className="flex-1">
          <span className="text-sm text-muted-foreground">1 website</span>
          <Heading className="text-2xl font-bold mb-2">{PLAN_NAME}</Heading>
          <p className="text-foreground/70 text-sm">
            Everything the product does, for one site. There is no other plan.
          </p>
        </div>
        <div className="text-center md:text-right">
          <div className="flex items-baseline justify-center md:justify-end gap-2">
            <span className="text-4xl font-bold">${PLAN_PRICE_USD}</span>
            <span className="text-muted-foreground">/month</span>
          </div>
          <div className="mt-4">{action}</div>
          <p className="text-xs text-muted-foreground mt-2">
            {TRIAL_DAYS} days free, card required. Then ${PLAN_PRICE_USD}/month,
            cancel anytime.
          </p>
        </div>
      </div>

      <ul className="space-y-3 mb-8">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <span className="text-green-600 dark:text-green-400">✓</span>
            <span className="text-sm">{feature}</span>
          </li>
        ))}
      </ul>

      <div className="pt-8 border-t">
        <div className="flex items-center gap-2 mb-4 justify-center flex-wrap">
          {measured.map((name) => (
            <span key={name} className="rounded-full border px-3 py-1 text-xs">
              {name}
            </span>
          ))}
        </div>
        <p className="text-center text-sm text-muted-foreground mb-6">
          Answer engines are asked the prompts you chose, and the answers are
          a sample, not a feed. Google is measured apart from that, by rank and
          by Search Console.
        </p>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="font-semibold mb-2">A plan before any writing</h4>
            <p className="text-sm text-foreground/70">
              The agent reads your site, names your niche and proposes keywords
              with a model-estimated volume, competition and difficulty for
              each.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-2">One article a day</h4>
            <p className="text-sm text-foreground/70">
              Planned against the current Google results, written to your
              business context, with internal links in place and images when
              you turn them on.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-2">Published where you publish</h4>
            <p className="text-sm text-foreground/70">
              WordPress directly, or a webhook your site receives. Webflow and
              Shopify are not connected yet.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-2">Measured, not assumed</h4>
            <p className="text-sm text-foreground/70">
              Rank on Google, citations in answer engines, and clicks counted by
              Search Console itself. A number nobody measured stays empty.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

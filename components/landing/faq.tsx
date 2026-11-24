"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { CONTACT_EMAIL, OPERATOR_NAME } from "@/lib/site";
import { engineSentence, type AnswerEngine } from "@/components/landing/engines";

export function FAQ({ engines }: { engines: readonly AnswerEngine[] }) {
  const asked = engineSentence(engines);
  return (
    <section id="faq" className="w-full max-w-[1200px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">Questions worth asking first</h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          Including the ones where the answer is not flattering.
        </p>
      </div>

      <div className="max-w-3xl mx-auto">
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="item-1">
            <AccordionTrigger>How quickly will I see results?</AccordionTrigger>
            <AccordionContent>
              Nobody can promise you a date, and anyone who does is selling the
              promise rather than the traffic. Search engines take weeks to
              months to trust a new page, and answer engines mostly quote what
              already ranks. What this product commits to is the other half:
              publishing consistently, and measuring honestly. You will see your
              rank, whether AI answers cite you, and the clicks Google Search
              Console counts, including when the answer is &ldquo;nothing
              yet&rdquo;.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-2">
            <AccordionTrigger>What does it cost?</AccordionTrigger>
            <AccordionContent>
              $79 a month, one site. The first 3 days are free and the card is
              collected when you start the trial, so the subscription starts by
              itself when the trial ends unless you cancel. You can cancel at
              any time after that too, from Billing. There is no other plan, no discount
              that expires tonight, and no higher price this one is marked down
              from.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-3">
            <AccordionTrigger>Is AI content good enough?</AccordionTrigger>
            <AccordionContent>
              It is good enough to publish and it is not a specialist writer who
              knows your industry. Each article is written to a 900 to 1,500
              word brief, planned against the current Google results for the
              keyword, written with your business description in the prompt,
              and checked by automated quality gates before it can go out.
              Until its day you can take any article off the calendar. On its
              day it is written and, once the checks pass, published
              automatically; one that fails a check is held back for you to
              read. Articles can&rsquo;t be edited in the app yet: you can
              regenerate one, or copy it out and publish it by hand.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-4">
            <AccordionTrigger>How do I use this day to day?</AccordionTrigger>
            <AccordionContent>
              Open Replies first: drafts in your voice for posts on X, Reddit,
              LinkedIn and other sites. Post the ones you like yourself; on X,
              Reply on X fills in the reply box, and a post that mentions you
              gets Post on X, which posts your reply from the X account you
              connected when you press it. GTF never posts on its own. Then look at Prompts: which
              engine cited you, and on the prompts you lost, which sources and
              competitors it cited instead. Put a page on the content calendar
              for that question. You do not need to live in the app.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-5">
            <AccordionTrigger>
              Which answer engines does it actually ask?
            </AccordionTrigger>
            <AccordionContent>
              {asked
                ? `Today, ${asked}.`
                : "None right now: no answer engine is switched on on this server, so no prompt is being asked."}{" "}
              {engines.length > 1 ? "Each keeps its own rate. " : ""}ChatGPT,
              Claude, Copilot and Google AI Overviews are not asked, so the
              product does not report them. No engine exposes &ldquo;was I
              cited&rdquo; as an API: every figure is a sample of your prompts,
              and a prompt that has not been run is &ldquo;not measured&rdquo;,
              never 0%.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-6">
            <AccordionTrigger>How do articles reach my site?</AccordionTrigger>
            <AccordionContent>
              Two ways today: WordPress, connected directly, or a webhook your
              site receives, which covers Next.js, Astro, custom stacks and
              anything that can accept a POST. Webflow and Shopify are listed in
              the app as coming soon and are not connected yet. You can also
              copy an article out by hand.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-7">
            <AccordionTrigger>Which languages?</AccordionTrigger>
            <AccordionContent>
              English, Italian, Spanish, French and German. The language of the
              content is independent of the language of your site.
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="item-8">
            <AccordionTrigger>Who is behind this?</AccordionTrigger>
            <AccordionContent>
              {OPERATOR_NAME ? `One person, ${OPERATOR_NAME}, who builds it` : "The maintainer, who builds it"} and answers the support email,{" "}
              <a
                className="underline underline-offset-4"
                href={`mailto:${CONTACT_EMAIL}`}
              >
                {CONTACT_EMAIL}
              </a>
              . GetTrafficFast is also its own customer: the articles on this
              site&rsquo;s blog are written by the same pipeline you would be
              paying for, with no special treatment.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  );
}

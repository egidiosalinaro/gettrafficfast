import { engineSentence, type AnswerEngine } from "@/components/landing/engines";

/**
 * What is actually measured, and what you do with it.
 * Engines that are not asked are not listed here.
 */
export function AISearch({ engines }: { engines: readonly AnswerEngine[] }) {
  const asked = engineSentence(engines);
  return (
    <section className="w-full max-w-[1100px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">Measure, then move the answer</h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          The same two jobs those AI-search tools are for: know whether you
          were cited, and change what the engine can find. The difference is
          both jobs live here, and a rate is only shown after a real run.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-2xl font-semibold mb-3">What gets measured</h3>
          <ul className="space-y-4 text-sm text-foreground/70">
            <li>
              <span className="font-medium text-foreground">Prompts you chose.</span>{" "}
              Not a scrape of every conversation on the internet. If you did
              not configure the question, it is not in the rate.
            </li>
            <li>
              <span className="font-medium text-foreground">
                {asked ? `${asked}.` : "No answer engine switched on yet."}
              </span>{" "}
              {asked
                ? "Those are the engines this server asks today. "
                : "Until one is, every prompt reads “not measured”. "}
              ChatGPT, Claude, Copilot and AI Overviews are not asked, so they
              are not reported. No engine says &ldquo;you were cited&rdquo; as
              an API: every rate is a sample of your prompts.
            </li>
            <li>
              <span className="font-medium text-foreground">One rate per engine.</span>{" "}
              Cited, not cited, or no readable answer. Sources only when the
              engine returned them. Competitors it named, if you already track
              them. No sentiment score, no single “visibility %” averaged
              across engines.
            </li>
          </ul>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-2xl font-semibold mb-3">What you do about it</h3>
          <ul className="space-y-4 text-sm text-foreground/70">
            <li>
              <span className="font-medium text-foreground">Content.</span>{" "}
              A page for the prompt you lost, planned against the current
              Google results, checked by quality gates, published to WordPress
              or your webhook on its day. Autopilot stays off until you turn
              it on.
            </li>
            <li>
              <span className="font-medium text-foreground">Replies.</span>{" "}
              Public conversations on X, Reddit, LinkedIn and other sites that
              match your keywords, plus any X post you add yourself. A draft in
              your voice that does not name your product, and a link to the
              original. You post it; on X, one click fills in the reply box.
              The product never posts for you.
            </li>
            <li>
              <span className="font-medium text-foreground">Google, separately.</span>{" "}
              Rank samples, and Search Console clicks once you connect it.
              That is not the same number as an answer-engine citation.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

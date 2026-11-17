import { engineSentence, type AnswerEngine } from "@/components/landing/engines";

function askStep(engines: readonly AnswerEngine[]): string {
  if (engines.length === 0) {
    return "A run asks each enabled prompt of each enabled engine. No answer engine is switched on on this server right now, so prompts stay “not measured” until one is.";
  }
  const each = engines.length > 1 ? " Each engine gets its own rate. They are not averaged." : "";
  return `A run asks each enabled prompt of each enabled engine. Today that is ${engineSentence(engines)}.${each} The answers are a sample, not every answer the engine ever gives.`;
}

function steps(engines: readonly AnswerEngine[]) {
  return [
    {
      n: "1",
      title: "Write the prompts",
      body: "The questions a buyer asks an assistant when they are looking for what you sell. Cluster them. Turn off the ones that are too generic to be worth a page.",
    },
    {
      n: "2",
      title: "Ask the engines",
      body: askStep(engines),
    },
    {
      n: "3",
      title: "Read the sources",
      body: "For every answer: cited, not cited, or no readable answer. The domains the engine returned, and the competitors it named. An excerpt, not a fabricated proof. A missing run stays “not measured”, never 0%.",
    },
    {
      n: "4",
      title: "Do the work the same day",
      body: "If you were not cited, put the page that should have been the source on your calendar, or open Replies: a draft in your voice for a post on X, Reddit or LinkedIn, which you post yourself. Nothing is posted to X, Reddit or anywhere else without you.",
    },
  ];
}

/**
 * The working day, in the order the product is built for.
 * Otterly, Peec and Profound are this loop: prompts, models, sources, action.
 */
export function DailyUse({ engines }: { engines: readonly AnswerEngine[] }) {
  return (
    <section id="day" className="w-full max-w-[1100px] mx-auto px-5 py-20">
      <div className="mb-12 max-w-2xl">
        <h2 className="text-4xl font-bold mb-4">How you use it</h2>
        <p className="text-xl text-foreground/70">
          A short pass, most days. You are not here to watch a chart. You are
          here to see which prompts you lost, and to put something citable
          where the answer was.
        </p>
      </div>
      <ol className="grid gap-4 md:grid-cols-2">
        {steps(engines).map((step) => (
          <li key={step.n} className="rounded-lg border bg-card p-6">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {step.n}
            </div>
            <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
            <p className="text-sm text-foreground/70">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

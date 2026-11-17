import { Button } from "@/components/ui/button";
import Link from "next/link";
import { PlanCard } from "@/components/landing/plan-card";
import type { AnswerEngine } from "@/components/landing/engines";

export function Pricing({ engines }: { engines: readonly AnswerEngine[] }) {
  return (
    <section id="pricing" className="w-full max-w-[1200px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">One plan, one price</h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          An article a day for your site and reply drafts for the
          conversations around it, then measured on Google and on answer
          engines.
        </p>
      </div>

      <div className="max-w-4xl mx-auto">
        <PlanCard
          engines={engines}
          action={
            <Button size="lg" className="w-full" asChild>
              <Link href="/pricing">Start the free trial</Link>
            </Button>
          }
        />
      </div>
    </section>
  );
}

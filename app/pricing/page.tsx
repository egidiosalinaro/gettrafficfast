import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CheckoutButton } from "@/components/pricing/checkout-button";
import { PlanCard } from "@/components/landing/plan-card";
import { enabledAnswerEngines } from "@/components/landing/enabled-engines";
import { hasActiveSubscription } from "@/lib/subscription";
import { CONTACT_EMAIL } from "@/lib/site";
import Link from "next/link";
import { APP_HOME } from "@/lib/app-home";

export default async function PricingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A subscriber has nothing to buy here: send them into the app.
  if (user) {
    const hasSubscription = await hasActiveSubscription(user.id);
    if (hasSubscription) {
      redirect(APP_HOME);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="w-full max-w-[1400px] mx-auto px-5 py-12">
        {/* Header */}
        <header className="w-full border-b mb-12 pb-6">
          <Link href="/" className="flex items-center">
            <span className="text-xl font-bold">GetTrafficFast</span>
          </Link>
        </header>

        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold mb-4">One plan, one price</h1>
            <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
              An article a day for your site and reply drafts for the
              conversations around it, then measured on Google and on answer
              engines.
            </p>
          </div>

          <PlanCard
            headingLevel="h2"
            engines={enabledAnswerEngines()}
            action={
              user ? (
                <CheckoutButton className="w-full" />
              ) : (
                <Link href="/auth/sign-up?next=%2Fpricing">
                  <button className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition">
                    Sign up to continue
                  </button>
                </Link>
              )
            }
          />

          <p className="text-center text-sm text-muted-foreground">
            Questions before you start? Write to{" "}
            <a
              className="underline underline-offset-4"
              href={`mailto:${CONTACT_EMAIL}`}
            >
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

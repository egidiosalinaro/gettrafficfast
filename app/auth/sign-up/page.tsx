import { SignUpForm } from "@/components/sign-up-form";
import { PLAN_PRICE_USD, TRIAL_DAYS } from "@/components/landing/plan-card";
import Link from "next/link";

/**
 * Sign up or sign in. The right-hand column used to carry a five-star quote
 * from a founder who does not exist, with a traffic number nobody measured.
 * What is left is the form and the one fact a new account needs: the trial
 * terms, from the same constants as the price card.
 */
export default function Page() {
  return (
    <div className="min-h-svh flex flex-col">
      <header className="w-full border-b">
        <div className="w-full max-w-[1400px] mx-auto px-5 py-4">
          <Link href="/" className="flex items-center">
            <span className="text-xl font-bold">GetTrafficFast</span>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-md space-y-4">
          <SignUpForm />
          <p className="text-center text-sm text-muted-foreground">
            New accounts start with {TRIAL_DAYS} days free, card required.
            Then ${PLAN_PRICE_USD}/month, cancel anytime.
          </p>
        </div>
      </div>
    </div>
  );
}

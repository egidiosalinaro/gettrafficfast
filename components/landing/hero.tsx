"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useState } from "react";
import { engineName, type AnswerEngine } from "@/components/landing/engines";
import { PLAN_PRICE_USD, TRIAL_DAYS } from "@/components/landing/plan-card";

export function Hero({ engines }: { engines: readonly AnswerEngine[] }) {
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    const supabase = createClient();
    setIsGoogleLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/confirm`,
        },
      });
      if (error) throw error;
    } catch (error) {
      console.error("Error signing in with Google:", error);
      setIsGoogleLoading(false);
    }
  };

  return (
    <section className="w-full max-w-[1200px] mx-auto px-5 py-20 text-center">
      <div className="mb-12">
        <p className="text-sm font-medium text-muted-foreground mb-4">
          AI search visibility
        </p>
        <h1 className="text-5xl md:text-6xl font-bold mb-6 leading-tight">
          See if AI recommends your product
        </h1>
        <p className="text-xl text-foreground/70 mb-6 max-w-2xl mx-auto">
          Track the prompts a buyer would ask. See which answer engines cite
          you, who they cite instead, and which sources they trust. Then act
          on it two ways: articles for your blog, one a day from your calendar,
          published once they pass the checks, and replies drafted in your voice for posts on X, Reddit and
          LinkedIn, which you post yourself.
        </p>
        <div className="flex flex-wrap justify-center gap-2 mb-8 text-xs">
          {/* Only the engines this server actually asks: a chip for one that
              is switched off would advertise a measurement nobody runs. */}
          {engines.map((engine) => (
            <span key={engine} className="rounded-full border px-3 py-1">
              {engineName(engine)} · sampled
            </span>
          ))}
          <span className="rounded-full border px-3 py-1">Google rank and Search Console</span>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Button
            size="lg"
            className="w-full sm:w-auto"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading}
          >
            {isGoogleLoading ? (
              "Connecting..."
            ) : (
              <>
                <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Continue with Google
              </>
            )}
          </Button>
          <Link href="/auth/sign-up">
            <Button variant="outline" size="lg" className="w-full sm:w-auto">
              Start the free trial
            </Button>
          </Link>
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          {TRIAL_DAYS} days free, card required. Then ${PLAN_PRICE_USD}/month,
          cancel anytime.
        </p>
      </div>
    </section>
  );
}

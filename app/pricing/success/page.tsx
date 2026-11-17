import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { hasActiveSubscription } from "@/lib/subscription";
import { APP_HOME } from "@/lib/app-home";

export default async function PricingSuccessPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-up");
  }

  // Wait a moment for webhook to process, then check subscription
  // If subscription is active, go into the app, otherwise stay on pricing
  const hasSubscription = await hasActiveSubscription(user.id);
  
  if (hasSubscription) {
    redirect(APP_HOME);
  } else {
    // Subscription not yet processed, redirect back to pricing
    // User can manually refresh or wait for webhook
    redirect("/pricing");
  }
}


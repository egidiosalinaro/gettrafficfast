import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { NextRequest, NextResponse } from "next/server";
import { getUserSubscription } from "@/lib/subscription";
import Stripe from "stripe";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's subscription to find Stripe customer ID
    const subscription = await getUserSubscription(user.id);

    if (!subscription?.stripe_customer_id) {
      return NextResponse.json(
        { error: "No subscription found" },
        { status: 404 }
      );
    }

    // Verify customer exists in Stripe before creating billing portal session
    try {
      await stripe.customers.retrieve(subscription.stripe_customer_id);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        if (error.code === "resource_missing") {
          console.error(
            `Customer ${subscription.stripe_customer_id} not found in Stripe. This might be a test/live mode mismatch.`
          );
          return NextResponse.json(
            {
              error:
                "Customer not found. Please contact support or try signing up again.",
            },
            { status: 404 }
          );
        }
      }
      throw error;
    }

    // The portal opens in the same tab (a new tab after an await is blocked
    // on iOS), so "Return" brings the owner back to the Billing page.
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${request.nextUrl.origin}/settings/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Error creating billing portal session:", error);
    
    // Handle specific Stripe errors
    if (error instanceof Stripe.errors.StripeError) {
      if (error.code === "resource_missing") {
        return NextResponse.json(
          {
            error:
              "Subscription not found in Stripe. Please contact support.",
          },
          { status: 404 }
        );
      }
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}


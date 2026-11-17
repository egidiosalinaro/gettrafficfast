import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reuse the customer only when one is already on record (e.g. a
    // resubscribe after cancellation). Otherwise NO customer is created here:
    // Checkout creates it when the session completes, so an abandoned
    // checkout leaves no ghost customer behind — and a double click cannot
    // mint duplicates.
    let customerId: string | null = null;

    const { data: existingSubscription } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    if (existingSubscription?.stripe_customer_id) {
      try {
        const customer = await stripe.customers.retrieve(
          existingSubscription.stripe_customer_id
        );
        if (!customer.deleted) {
          customerId = existingSubscription.stripe_customer_id;
        }
      } catch {
        // Stored id no longer valid on Stripe — fall through and let
        // Checkout create a fresh customer instead of failing the session.
      }
    }

    // Get the price ID from environment variable or use default
    // You should set STRIPE_PRICE_ID in your .env.local
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      return NextResponse.json(
        { error: "Stripe price ID not configured" },
        { status: 500 }
      );
    }

    // Create checkout session with subscription and trial. The trial is
    // genuinely free: Checkout collects and verifies the card, and the first
    // charge happens when the trial ends.
    const session = await stripe.checkout.sessions.create({
      ...(customerId ? { customer: customerId } : { customer_email: user.email }),
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 3,
        metadata: {
          user_id: user.id,
        },
      },
      success_url: `${request.nextUrl.origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${request.nextUrl.origin}/pricing/cancel`,
      metadata: {
        user_id: user.id,
      },
    });

    return NextResponse.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

import * as Sentry from "@sentry/nextjs";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

// Type alias to avoid conflict with our Subscription type
type StripeSubscription = Stripe.Subscription;

// Lazy: avoid throwing at module import if env is missing in unrelated contexts.
const supabaseAdmin = () => createAdminClient();

const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET ?? "";

// Disable body parsing and force dynamic rendering
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A subscription event whose Supabase user cannot be found. Not a 200: the
 * payment would be marked processed and lost. It answers 500, so Stripe
 * retries, and goes to Sentry, so the operator sees it before the retries run
 * out.
 */
class UnresolvedStripeUserError extends Error {
  constructor(
    readonly subscriptionId: string,
    readonly customerId: string | null
  ) {
    super(`No Supabase user for Stripe subscription ${subscriptionId} (customer ${customerId ?? "none"})`);
    this.name = "UnresolvedStripeUserError";
  }
}

export async function POST(request: NextRequest) {
  try {
    // Get raw body as text (critical for signature verification)
    // Next.js App Router automatically handles raw body when using request.text()
    const body = await request.text();
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      console.error("Webhook: No signature provided");
      return NextResponse.json(
        { error: "No signature provided" },
        { status: 400 }
      );
    }

    if (!webhookSecret()) {
      console.error("Webhook: STRIPE_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 }
      );
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret());
      console.log(`Webhook received: ${event.type} (ID: ${event.id})`);
    } catch (err) {
      // The reason only: the signature header and the payload stay out of
      // the logs, which are read by more people than the Stripe dashboard.
      console.error(
        "Webhook signature verification failed:",
        err instanceof Error ? err.message : String(err)
      );
      return NextResponse.json(
        { error: "Webhook signature verification failed" },
        { status: 400 }
      );
    }

    // Idempotency: an event already processed is acknowledged and skipped.
    // The record is written only once processing succeeded, so a delivery
    // that failed (or was refused with 500) is processed again on Stripe's
    // retry. Two concurrent deliveries can both process: every write below
    // is an upsert of the state Stripe holds, so the second changes nothing.
    const { data: seen, error: seenError } = await supabaseAdmin()
      .from("processed_stripe_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();

    if (seenError) {
      console.error("Failed to read webhook idempotency record:", seenError);
      return NextResponse.json(
        { error: "Failed to read webhook event record" },
        { status: 500 }
      );
    }
    if (seen) {
      console.log(`Webhook duplicate ignored: ${event.id}`);
      return NextResponse.json({ received: true, duplicate: true });
    }

    try {
      await processEvent(event);
    } catch (error) {
      console.error("Error processing webhook:", error);
      reportWebhookFailure(error, event);
      return NextResponse.json(
        { error: "Webhook processing failed" },
        { status: 500 }
      );
    }

    const { error: recordError } = await supabaseAdmin()
      .from("processed_stripe_events")
      .insert({ event_id: event.id, event_type: event.type });

    // 23505: a concurrent delivery recorded it first. Any other failure is
    // logged and still acknowledged: the state is written, and a retry would
    // only write the same state again.
    if (recordError && recordError.code !== "23505") {
      console.error("Failed to record processed webhook event:", recordError);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Error in webhook handler:", error);
    Sentry.captureException(error, { tags: { stripe_webhook: "handler" } });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function reportWebhookFailure(error: unknown, event: Stripe.Event) {
  if (error instanceof UnresolvedStripeUserError) {
    Sentry.captureException(error, {
      level: "error",
      fingerprint: ["stripe-webhook", "unresolved-user"],
      tags: { stripe_webhook: "unresolved_user", stripe_event_type: event.type },
      extra: {
        event_id: event.id,
        subscription_id: error.subscriptionId,
        customer_id: error.customerId,
      },
    });
    return;
  }
  Sentry.captureException(error, {
    tags: { stripe_webhook: "processing", stripe_event_type: event.type },
    extra: { event_id: event.id },
  });
}

async function processEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(`Processing checkout.session.completed for session: ${session.id}`);

      if (session.mode === "subscription" && session.subscription) {
        const subscription: StripeSubscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );

        console.log(`Retrieved subscription: ${subscription.id} for customer: ${subscription.customer}`);

        // Checkout created this customer itself (no customer is created
        // before payment any more), so tag it with the Supabase user id —
        // the reconciliation fallback below relies on that metadata.
        const sessionUserId = session.metadata?.user_id;
        if (sessionUserId && typeof session.customer === "string") {
          try {
            const customer = await stripe.customers.retrieve(session.customer);
            if (!customer.deleted && !customer.metadata.supabase_user_id) {
              await stripe.customers.update(session.customer, {
                metadata: { supabase_user_id: sessionUserId },
              });
            }
          } catch (err) {
            console.error("Failed to tag customer with supabase_user_id:", err);
          }
        }

        // The session knows whose checkout it was, so the user resolves even
        // when the subscription carries no metadata of its own.
        await handleSubscriptionUpdate(subscription, sessionUserId);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      // The payload is the state when the event was created, and events
      // arrive out of order: a late `updated` would otherwise bring a
      // canceled subscription back to active. What Stripe holds now is
      // written instead.
      const payload = event.data.object as StripeSubscription;
      console.log(`Processing ${event.type} for subscription: ${payload.id}`);
      const current: StripeSubscription = await stripe.subscriptions.retrieve(payload.id);
      await handleSubscriptionUpdate(current);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as StripeSubscription;
      console.log(`Processing subscription deletion: ${subscription.id}`);
      await handleSubscriptionDeletion(subscription);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
}

async function handleSubscriptionUpdate(
  stripeSubscription: StripeSubscription,
  fallbackUserId?: string
) {
  let userId: string | undefined = stripeSubscription.metadata?.user_id || fallbackUserId;

  // If no user_id in subscription metadata, try to get it from customer metadata
  if (!userId && typeof stripeSubscription.customer === "string") {
    const customer = await stripe.customers.retrieve(stripeSubscription.customer);
    if (!customer.deleted && "metadata" in customer) {
      userId = customer.metadata.supabase_user_id || undefined;
    }
  }

  if (!userId) {
    throw new UnresolvedStripeUserError(
      stripeSubscription.id,
      typeof stripeSubscription.customer === "string" ? stripeSubscription.customer : null
    );
  }

  // The object is always the one just retrieved from Stripe, so whatever
  // periods it carries are current. (On this API version the periods live on
  // the subscription items; the top-level fields read here are absent and the
  // columns stay null, which hasActiveSubscription reads as "no end".)
  const fullSubscription = stripeSubscription;
  const fullSubscriptionPeriods = fullSubscription as unknown as {
    current_period_start?: number | null;
    current_period_end?: number | null;
  };
  const subPeriodStart = fullSubscriptionPeriods.current_period_start;
  const subPeriodEnd = fullSubscriptionPeriods.current_period_end;

  const subscriptionData = {
    user_id: userId,
    stripe_customer_id: fullSubscription.customer as string,
    stripe_subscription_id: fullSubscription.id,
    status: fullSubscription.status,
    current_period_start: subPeriodStart
      ? new Date(subPeriodStart * 1000).toISOString()
      : null,
    current_period_end: subPeriodEnd
      ? new Date(subPeriodEnd * 1000).toISOString()
      : null,
    cancel_at_period_end: fullSubscription.cancel_at_period_end || false,
    updated_at: new Date().toISOString(),
  };

  console.log(
    `Upserting subscription ${subscriptionData.stripe_subscription_id}: ${subscriptionData.status}`
  );

  // Upsert subscription
  const { data, error } = await supabaseAdmin()
    .from("subscriptions")
    .upsert(subscriptionData, {
      onConflict: "stripe_subscription_id",
    })
    .select();

  if (error) {
    console.error("Error upserting subscription:", error);
    throw error;
  }

  console.log(`Subscription upserted: ${data?.length ?? 0} row(s)`);
}

async function handleSubscriptionDeletion(subscription: StripeSubscription) {
  const { error } = await supabaseAdmin()
    .from("subscriptions")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error("Error updating deleted subscription:", error);
    throw error;
  }
}


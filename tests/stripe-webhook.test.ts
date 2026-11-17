import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * The Stripe webhook. What is pinned: a bad signature is refused and nothing
 * about it reaches the logs but the reason; an event already processed is
 * acknowledged and not processed again, and the idempotency record is
 * written only once processing succeeded; a subscription whose user cannot
 * be found answers 500 and goes to Sentry, so Stripe retries and the
 * operator sees it, instead of a 200 that loses the payment; and a
 * subscription event writes what Stripe holds now, not the (possibly stale)
 * payload. Stripe, Supabase and Sentry are mocked.
 */

const mocks = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  constructEvent: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: mocks.constructEvent },
    subscriptions: { retrieve: mocks.retrieveSubscription },
    customers: { retrieve: mocks.retrieveCustomer, update: mocks.updateCustomer },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const SIGNATURE = "t=1,v1=deadbeefsignature";
const BODY = JSON.stringify({ id: "evt_1", secret_payload_marker: "do-not-log" });

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { user_id: "user-1" },
    cancel_at_period_end: false,
    ...over,
  };
}

function event(type: string, object: Record<string, unknown>, id = "evt_1") {
  return { id, type, data: { object } };
}

async function deliver(signature: string | null = SIGNATURE) {
  const { POST } = await import("@/app/api/stripe-webhook/route");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["stripe-signature"] = signature;
  const request = new Request("https://gettrafficfa.st/api/stripe-webhook", { method: "POST", headers, body: BODY });
  return POST(request as never);
}

beforeEach(() => {
  mocks.db = new FakeSupabase({ processed_stripe_events: [], subscriptions: [] });
  mocks.constructEvent.mockReset();
  mocks.retrieveSubscription.mockReset();
  mocks.retrieveCustomer.mockReset();
  mocks.updateCustomer.mockReset();
  mocks.captureException.mockReset();
});

describe("signature", () => {
  it("refuses a delivery whose signature does not verify, and logs only the reason", async () => {
    mocks.constructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await deliver();
    expect(response.status).toBe(400);
    const logged = errors.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("No signatures found");
    expect(logged).not.toContain(SIGNATURE);
    expect(logged).not.toContain("do-not-log");
    errors.mockRestore();
    expect(mocks.db.tables.processed_stripe_events).toEqual([]);
    expect(mocks.db.tables.subscriptions).toEqual([]);
  });

  it("refuses a delivery with no signature at all", async () => {
    const response = await deliver(null);
    expect(response.status).toBe(400);
    expect(mocks.constructEvent).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("processes an event once, records it after success, and acknowledges a redelivery without processing", async () => {
    mocks.constructEvent.mockReturnValue(event("customer.subscription.updated", subscription()));
    mocks.retrieveSubscription.mockResolvedValue(subscription());

    const first = await deliver();
    expect(first.status).toBe(200);
    expect(mocks.db.tables.processed_stripe_events).toMatchObject([
      { event_id: "evt_1", event_type: "customer.subscription.updated" },
    ]);
    expect(mocks.db.tables.subscriptions).toHaveLength(1);

    const second = await deliver();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(mocks.retrieveSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.db.tables.processed_stripe_events).toHaveLength(1);
  });

  it("does not record an event whose processing failed, so Stripe's retry processes it", async () => {
    mocks.constructEvent.mockReturnValue(event("customer.subscription.updated", subscription()));
    mocks.retrieveSubscription.mockRejectedValueOnce(new Error("Stripe is down"));

    const failed = await deliver();
    expect(failed.status).toBe(500);
    expect(mocks.db.tables.processed_stripe_events).toEqual([]);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);

    mocks.retrieveSubscription.mockResolvedValue(subscription());
    const retried = await deliver();
    expect(retried.status).toBe(200);
    expect(mocks.db.tables.processed_stripe_events).toHaveLength(1);
    expect(mocks.db.tables.subscriptions).toHaveLength(1);
  });
});

describe("a subscription with no user", () => {
  it("answers 500, reports to Sentry and records nothing", async () => {
    const orphan = subscription({ metadata: {} });
    mocks.constructEvent.mockReturnValue(event("customer.subscription.updated", orphan));
    mocks.retrieveSubscription.mockResolvedValue(orphan);
    mocks.retrieveCustomer.mockResolvedValue({ id: "cus_1", deleted: false, metadata: {} });

    const response = await deliver();
    expect(response.status).toBe(500);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = mocks.captureException.mock.calls[0];
    expect((error as Error).name).toBe("UnresolvedStripeUserError");
    expect(context).toMatchObject({
      fingerprint: ["stripe-webhook", "unresolved-user"],
      extra: { event_id: "evt_1", subscription_id: "sub_1", customer_id: "cus_1" },
    });
    expect(mocks.db.tables.processed_stripe_events).toEqual([]);
    expect(mocks.db.tables.subscriptions).toEqual([]);
  });

  it("resolves the user from the customer's metadata when the subscription has none", async () => {
    const orphan = subscription({ metadata: {} });
    mocks.constructEvent.mockReturnValue(event("customer.subscription.created", orphan));
    mocks.retrieveSubscription.mockResolvedValue(orphan);
    mocks.retrieveCustomer.mockResolvedValue({ id: "cus_1", deleted: false, metadata: { supabase_user_id: "user-9" } });

    expect((await deliver()).status).toBe(200);
    expect(mocks.db.tables.subscriptions).toMatchObject([{ user_id: "user-9", stripe_subscription_id: "sub_1" }]);
  });

  it("resolves the user from the checkout session when neither carries it", async () => {
    const orphan = subscription({ metadata: {} });
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        subscription: "sub_1",
        customer: "cus_1",
        metadata: { user_id: "user-7" },
      })
    );
    mocks.retrieveSubscription.mockResolvedValue(orphan);
    mocks.retrieveCustomer.mockResolvedValue({ id: "cus_1", deleted: false, metadata: {} });

    expect((await deliver()).status).toBe(200);
    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_1", { metadata: { supabase_user_id: "user-7" } });
    expect(mocks.db.tables.subscriptions).toMatchObject([{ user_id: "user-7", status: "active" }]);
  });
});

describe("a late customer.subscription.updated", () => {
  it("writes the state Stripe holds now, not the stale payload", async () => {
    mocks.db.tables.subscriptions.push({
      id: "row-1",
      user_id: "user-1",
      stripe_subscription_id: "sub_1",
      stripe_customer_id: "cus_1",
      status: "canceled",
    });
    // The payload says active (it was created before the cancellation);
    // Stripe says canceled.
    mocks.constructEvent.mockReturnValue(event("customer.subscription.updated", subscription({ status: "active" })));
    mocks.retrieveSubscription.mockResolvedValue(subscription({ status: "canceled" }));

    expect((await deliver()).status).toBe(200);
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith("sub_1");
    expect(mocks.db.tables.subscriptions).toHaveLength(1);
    expect(mocks.db.tables.subscriptions[0].status).toBe("canceled");
  });
});

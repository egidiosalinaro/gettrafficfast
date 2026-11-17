import { describe, expect, it } from "vitest";
import { recentDeliveriesEq } from "@/lib/integrations/deliveries";

describe("recentDeliveriesEq", () => {
  it("always names the site, not only the account", () => {
    expect(
      recentDeliveriesEq({
        userId: "user-1",
        businessId: "gtf",
        integrationType: "webhook",
      })
    ).toEqual({
      user_id: "user-1",
      business_id: "gtf",
      integration_type: "webhook",
    });
  });

  it("does not reuse another site's id when the type matches", () => {
    const postwren = recentDeliveriesEq({
      userId: "user-1",
      businessId: "postwren",
      integrationType: "webhook",
    });
    const gtf = recentDeliveriesEq({
      userId: "user-1",
      businessId: "gtf",
      integrationType: "webhook",
    });
    expect(postwren.user_id).toBe(gtf.user_id);
    expect(postwren.business_id).not.toBe(gtf.business_id);
  });
});

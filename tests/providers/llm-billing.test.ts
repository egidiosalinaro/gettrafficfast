import { describe, expect, it } from "vitest";
import { isProviderBillingFailure, llmFailureKind } from "@/lib/providers/llm/types";

describe("isProviderBillingFailure", () => {
  it("recognises a depleted prepayment balance and ignores other failures", () => {
    const billing = new Error(
      "[402 Payment Required] Your prepayment credits are depleted. Please manage billing."
    );
    expect(isProviderBillingFailure(billing)).toBe(true);
    expect(isProviderBillingFailure(Object.assign(new Error("Payment Required"), { status: 402 }))).toBe(true);
    expect(isProviderBillingFailure(Object.assign(new Error("nope"), { status: 402 }))).toBe(false);
    expect(isProviderBillingFailure(new Error("429 Too Many Requests"))).toBe(false);
    expect(isProviderBillingFailure(new Error("model not found"))).toBe(false);
  });
});

describe("llmFailureKind", () => {
  it("reads billing and an unavailable provider from the sentences the providers write", () => {
    expect(llmFailureKind("Gemini credits are depleted. Generation stays paused until billing is topped up.")).toBe("billing");
    expect(llmFailureKind("Claude refused the call because the account cannot pay: [400 invalid_request_error] Your credit balance is too low")).toBe("billing");
    // A timed-out fallback behind a depleted primary is still a balance to top up.
    expect(llmFailureKind("Gemini credits are depleted. The fallback failed too: Claude did not answer in time.")).toBe("billing");
    expect(llmFailureKind("Claude did not answer in time.")).toBe("unavailable");
    expect(llmFailureKind("GEMINI_API_KEY is not set")).toBe("unavailable");
    expect(llmFailureKind("No draft was saved, because none passed the check.")).toBeNull();
    expect(llmFailureKind(null)).toBeNull();
  });
});

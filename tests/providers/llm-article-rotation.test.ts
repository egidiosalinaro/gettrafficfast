import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { articleRotation, chooseArticleArm, getLlmProvider, llmChain, setLlmProvider } from "@/lib/providers/llm/registry";
import { LlmError } from "@/lib/providers/llm/types";

/**
 * `LLM_ARTICLE_ROTATION`: the article agents alternate between providers by
 * UTC day. The registry chooses the arm of the day once per job
 * (`chooseArticleArm`) and, given that arm back, puts its provider first
 * with the other behind it. Unset, nothing changes; set, it wins over
 * `LLM_WRITER_PROVIDER` for the article agents and touches nobody else.
 */

const at = (iso: string) => new Date(iso);

function claudeAnswers(model: string) {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          model,
          content: [{ type: "text", text: "from claude" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  setLlmProvider(null);
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("LLM_FALLBACK", "");
  vi.stubEnv("LLM_WRITER_PROVIDER", "");
  vi.stubEnv("LLM_ARTICLE_ROTATION", "");
  vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLlmProvider(null);
});

describe("the arm of the day", () => {
  it("is nobody when the variable is unset or empty", () => {
    expect(articleRotation()).toBeNull();
    expect(chooseArticleArm(at("2026-11-10T12:00:00Z"))).toEqual({ arm: null });
    vi.stubEnv("LLM_ARTICLE_ROTATION", " , ");
    expect(chooseArticleArm()).toEqual({ arm: null });
  });

  it("is the UTC day number modulo the list length", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    // Day 0 and day 1 of the epoch anchor the rule.
    expect(chooseArticleArm(at("1970-01-01T00:00:00Z")).arm).toBe("gemini");
    expect(chooseArticleArm(at("1970-01-02T00:00:00Z")).arm).toBe("anthropic");
    // 2026-11-10 is day 20767: odd, the second entry.
    expect(chooseArticleArm(at("2026-11-10T09:00:00Z"))).toEqual({
      arm: "anthropic",
      day: "2026-11-10",
      rotation: ["gemini", "anthropic"],
    });
    expect(chooseArticleArm(at("2026-11-11T09:00:00Z"))).toMatchObject({ arm: "gemini", day: "2026-11-11" });
    expect(chooseArticleArm(at("2026-11-12T09:00:00Z")).arm).toBe("anthropic");
  });

  it("changes at midnight UTC, not at anybody's local midnight", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    expect(chooseArticleArm(at("2026-11-10T00:00:00.000Z")).arm).toBe("anthropic");
    expect(chooseArticleArm(at("2026-11-10T23:59:59.999Z"))).toMatchObject({ arm: "anthropic", day: "2026-11-10" });
    expect(chooseArticleArm(at("2026-11-11T00:00:00.000Z"))).toMatchObject({ arm: "gemini", day: "2026-11-11" });
    // 01:30 on the 11th in Berlin is still the 10th in UTC.
    expect(chooseArticleArm(at("2026-11-11T01:30:00+02:00")).day).toBe("2026-11-10");
  });

  it("with a list of one, is that provider every day", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "anthropic");
    expect(chooseArticleArm(at("2026-11-10T09:00:00Z")).arm).toBe("anthropic");
    expect(chooseArticleArm(at("2026-11-11T09:00:00Z")).arm).toBe("anthropic");
    // The default provider stands behind it.
    expect(llmChain(undefined, "anthropic")).toEqual(["anthropic", "gemini"]);
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini");
    expect(llmChain(undefined, "gemini")).toEqual(["gemini"]);
  });

  it("cycles a list of three, and accepts claude as a name and stray spaces", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", " Gemini , claude ,gemini");
    expect(articleRotation()).toEqual(["gemini", "anthropic", "gemini"]);
    expect(["1970-01-01", "1970-01-02", "1970-01-03", "1970-01-04"].map((d) => chooseArticleArm(at(`${d}T00:00:00Z`)).arm)).toEqual([
      "gemini",
      "anthropic",
      "gemini",
      "gemini",
    ]);
  });

  it("refuses a name it cannot build, and says which variable holds it", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,openai");
    try {
      chooseArticleArm();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).message).toBe(
        'Unknown LLM provider in LLM_ARTICLE_ROTATION: "openai". Use a comma list of: gemini, anthropic.'
      );
      expect((err as LlmError).retryable).toBe(false);
    }
  });
});

describe("the chain of a job on an arm", () => {
  it("puts the arm first and the other provider of the rotation behind it", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    expect(llmChain(undefined, "anthropic")).toEqual(["anthropic", "gemini"]);
    expect(llmChain(undefined, "gemini")).toEqual(["gemini", "anthropic"]);
    expect(getLlmProvider(undefined, "anthropic").name).toBe("anthropic+gemini");
    expect(getLlmProvider(undefined, "gemini").name).toBe("gemini+anthropic");
  });

  it("decides for the article agents over LLM_WRITER_PROVIDER, and logs that once", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    // A Gemini day: the writer goes to Gemini although its own variable says Claude.
    expect(llmChain("writer", "gemini")).toEqual(["gemini", "anthropic"]);
    expect(llmChain(undefined, "gemini")).toEqual(["gemini", "anthropic"]);
    expect(llmChain("writer", "anthropic")).toEqual(["anthropic", "gemini"]);

    const lines = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((line) => line.event === "llm.article_rotation");
    expect(lines).toEqual([
      {
        level: "info",
        event: "llm.article_rotation",
        rotation: ["gemini", "anthropic"],
        arm: "gemini",
        fallback: "anthropic",
        ignored: "LLM_WRITER_PROVIDER=anthropic",
      },
    ]);
  });

  it("leaves everyone who passes no arm exactly where they were", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    // Reply drafts, AI Visibility, discovery: no role, no arm.
    expect(llmChain()).toEqual(["gemini"]);
    expect(getLlmProvider().name).toBe("gemini");
    // A writer outside production (no arm) still follows its own variable.
    expect(llmChain("writer")).toEqual(["anthropic", "gemini"]);
    expect(llmChain("writer", null)).toEqual(["anthropic", "gemini"]);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("is today's behaviour exactly when the rotation is unset, whatever arm a job carries", () => {
    expect(llmChain(undefined, "anthropic")).toEqual(["gemini"]);
    expect(llmChain("writer", "anthropic")).toEqual(["gemini"]);
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    expect(llmChain("writer", "gemini")).toEqual(["anthropic", "gemini"]);
    expect(llmChain(undefined, "anthropic")).toEqual(["gemini", "anthropic"]);
    expect(getLlmProvider("writer", "gemini")).toBe(getLlmProvider("writer"));
    expect(getLlmProvider(undefined, "anthropic")).toBe(getLlmProvider());
  });

  it("drops an arm that was taken out of the rotation: the variable is the consent", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini");
    expect(llmChain(undefined, "anthropic")).toEqual(["gemini"]);
  });

  it("a stub set by a test answers for every arm", () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    const stub = { name: "stub", generateText: vi.fn(), generateStructured: vi.fn() };
    setLlmProvider(stub);
    expect(getLlmProvider("writer", "anthropic")).toBe(stub);
  });
});

describe("a call on an arm", () => {
  it("on a Claude day sends a fast agent to Haiku 5.5 with low effort and no temperature", async () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    const fetchMock = claudeAnswers("claude-haiku-5-5");

    const result = await getLlmProvider(undefined, "anthropic").generateText("Outline.", { tier: "fast", temperature: 0.2 });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(body).not.toHaveProperty("temperature");
    expect(result.usage).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", fallback: false });
    expect(result.usage.costUsd).toBeCloseTo((10 * 0.1 + 5 * 0.5) / 1_000_000);
  });

  it("keeps the writer on the quality model on a Claude day", async () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    const fetchMock = claudeAnswers("claude-sonnet-5-5");

    const result = await getLlmProvider("writer", "anthropic").generateText("Write.", { tier: "quality", keepTier: true });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("claude-sonnet-5-5");
    expect(result.usage).toMatchObject({ provider: "anthropic", fallback: false, tierDowngraded: false });
  });

  it("records a fallback when the day's provider cannot serve, and the quality tier stays quality", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
    // A Gemini day on which Gemini cannot be built: Claude stands behind it.
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetchMock = claudeAnswers("claude-sonnet-5-5");

    const result = await getLlmProvider("writer", "gemini").generateText("Write.", { tier: "quality", keepTier: true });

    expect(result.text).toBe("from claude");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("claude-sonnet-5-5");
    expect(result.usage).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", fallback: true, tierDowngraded: false });
  });
});

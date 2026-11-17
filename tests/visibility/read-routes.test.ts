import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { visibilitySeed } from "../support/visibility-seed";

/**
 * The AI Visibility reads live in lib/visibility/read.ts, which the routes
 * and the visibility tools share. Pinned: each GET route's answer, captured
 * before the prompt list, the run list and the settings read moved out of
 * the routes. Rates stay per engine and null over nothing.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  businessId: "biz-1" as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => m.businessId,
}));
vi.mock("@/lib/providers/citations/registry", () => ({
  getCitationProviders: () => [{ name: "gemini" }, { name: "perplexity" }],
}));

import { GET as overview } from "@/app/api/visibility/route";
import { GET as queries } from "@/app/api/visibility/queries/route";
import { GET as queryDetail } from "@/app/api/visibility/queries/[id]/route";
import { GET as settings } from "@/app/api/visibility/settings/route";

beforeEach(() => {
  m.businessId = "biz-1";
  m.db = visibilitySeed();
});

describe("GET /api/visibility", () => {
  it("answers exactly what it answered before the run list moved", async () => {
    const response = await overview();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "activeEngines": [
          "gemini",
          "perplexity",
        ],
        "business": {
          "name": "Acme",
          "websiteUrl": "https://acme.test",
        },
        "comparison": {
          "byEngine": [
            {
              "delta": 50,
              "engine": "gemini",
              "previousCited": 0,
              "previousRate": 0,
              "previousValid": 1,
              "rate": 0.5,
            },
            {
              "delta": null,
              "engine": "perplexity",
              "previousCited": 0,
              "previousRate": 0,
              "previousValid": 1,
              "rate": null,
            },
          ],
          "comparable": true,
          "previousRunId": "run-1",
          "reasons": [],
        },
        "competitors": [
          {
            "asMention": 0,
            "asSource": 2,
            "count": 2,
            "domain": "rival.test",
            "name": "Rival",
          },
        ],
        "configuredEngines": [
          "gemini",
          "perplexity",
        ],
        "hasBusiness": true,
        "identity": {
          "brandNames": [
            "Acme",
          ],
          "domains": [
            "acme.test",
            "blog.acme.test",
          ],
        },
        "lastError": "No prompts enabled.",
        "latestRun": {
          "engines": [
            "gemini",
            "perplexity",
          ],
          "error": null,
          "finishedAt": "2026-11-08T10:00:00.000Z",
          "id": "run-2",
          "plannedProbes": 4,
          "queryCount": 2,
          "queryFingerprint": "fp-1",
          "startedAt": "2026-11-08T10:00:00.000Z",
          "status": "completed",
          "trigger": "manual",
        },
        "places": {
          "fromLatestRun": 0,
          "open": 0,
        },
        "queries": {
          "clusters": [
            "basics",
          ],
          "enabled": 1,
          "total": 2,
        },
        "rows": [
          {
            "answerExcerpt": "An answer.",
            "change": "gained",
            "checkedAt": "2026-11-08T10:00:00.000Z",
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "gemini",
            "error": null,
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": 2,
            "previousStatus": "not_cited",
            "probeId": "p-3",
            "query": "best ai seo tool",
            "queryId": "q-1",
            "sourceUrl": "https://acme.test/ai-seo",
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "cited",
          },
          {
            "answerExcerpt": null,
            "change": "unknown",
            "checkedAt": "2026-11-08T10:00:00.000Z",
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "perplexity",
            "error": "timeout",
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": null,
            "previousStatus": "not_cited",
            "probeId": "p-4",
            "query": "best ai seo tool",
            "queryId": "q-1",
            "sourceUrl": null,
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "error",
          },
          {
            "answerExcerpt": "An answer.",
            "change": "new",
            "checkedAt": "2026-11-08T10:00:00.000Z",
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "gemini",
            "error": null,
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": null,
            "previousStatus": null,
            "probeId": "p-5",
            "query": "retired prompt",
            "queryId": null,
            "sourceUrl": null,
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "not_cited",
          },
        ],
        "runs": [
          {
            "engines": [
              "gemini",
              "perplexity",
            ],
            "error": "No prompts enabled.",
            "finishedAt": "2026-11-09T09:00:00.000Z",
            "id": "run-3",
            "plannedProbes": 0,
            "queryCount": 2,
            "queryFingerprint": "fp-1",
            "startedAt": "2026-11-09T09:00:00.000Z",
            "status": "failed",
            "trigger": "manual",
          },
          {
            "engines": [
              "gemini",
              "perplexity",
            ],
            "error": null,
            "finishedAt": "2026-11-08T10:00:00.000Z",
            "id": "run-2",
            "plannedProbes": 4,
            "queryCount": 2,
            "queryFingerprint": "fp-1",
            "startedAt": "2026-11-08T10:00:00.000Z",
            "status": "completed",
            "trigger": "manual",
          },
          {
            "engines": [
              "gemini",
              "perplexity",
            ],
            "error": null,
            "finishedAt": "2026-11-01T10:00:00.000Z",
            "id": "run-1",
            "plannedProbes": 4,
            "queryCount": 2,
            "queryFingerprint": "fp-1",
            "startedAt": "2026-11-01T10:00:00.000Z",
            "status": "completed",
            "trigger": "manual",
          },
        ],
        "settings": {
          "brandNames": [
            "Acme",
          ],
          "cadence": "weekly",
          "domains": [
            "blog.acme.test",
          ],
          "engines": [],
          "maxQueriesPerRun": 20,
          "placesFromSources": true,
        },
        "sources": [
          {
            "count": 2,
            "domain": "rival.test",
            "title": "Rival",
            "url": "https://rival.test/a",
          },
        ],
        "summary": {
          "cited": 1,
          "engines": [
            {
              "cited": 1,
              "coverage": 1,
              "engine": "gemini",
              "errors": 0,
              "invalid": 0,
              "mentioned": 0,
              "pending": 0,
              "planned": 2,
              "rate": 0.5,
              "valid": 2,
            },
            {
              "cited": 0,
              "coverage": 0,
              "engine": "perplexity",
              "errors": 1,
              "invalid": 0,
              "mentioned": 0,
              "pending": 0,
              "planned": 1,
              "rate": null,
              "valid": 0,
            },
          ],
          "errors": 1,
          "invalid": 0,
          "pending": 0,
          "planned": 3,
          "queriesCited": 1,
          "queriesMeasured": 2,
          "runId": "run-2",
          "valid": 2,
        },
      }
    `);
  });
});

describe("GET /api/visibility/queries", () => {
  it("answers exactly what it answered before the prompt list moved to lib", async () => {
    const response = (await queries())!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "queries": [
          {
            "cluster": null,
            "createdAt": "2026-10-02T00:00:00.000Z",
            "enabled": false,
            "id": "q-2",
            "intent": null,
            "query": "what is aeo",
            "source": "suggested",
          },
          {
            "cluster": "basics",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "enabled": true,
            "id": "q-1",
            "intent": "commercial",
            "query": "best ai seo tool",
            "source": "manual",
          },
        ],
      }
    `);
  });

  it("answers 409 with no site", async () => {
    m.businessId = null;
    const response = (await queries())!;
    expect(response.status).toBe(409);
  });
});

describe("GET /api/visibility/queries/:id", () => {
  it("answers one prompt's history, and 404 for another site's", async () => {
    const ok = await queryDetail(new Request("https://gettrafficfa.st") as never, { params: Promise.resolve({ id: "q-1" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchInlineSnapshot(`
      {
        "articles": [
          {
            "id": "art-1",
            "keyword": "ai seo",
            "publishedUrl": "https://acme.test/ai-seo",
            "status": "published",
            "title": "AI SEO",
            "via": "cited",
          },
          {
            "id": "art-2",
            "keyword": "Best AI SEO tool",
            "publishedUrl": null,
            "status": "generated",
            "title": "Best AI SEO tool",
            "via": "keyword",
          },
        ],
        "competitors": [
          {
            "asMention": 0,
            "asSource": 3,
            "count": 3,
            "domain": "rival.test",
            "name": "Rival",
          },
        ],
        "history": [
          {
            "cited": 1,
            "engine": "gemini",
            "points": [
              {
                "checkedAt": "2026-11-01T10:00:00.000Z",
                "mentioned": false,
                "position": null,
                "runId": "run-1",
                "status": "not_cited",
              },
              {
                "checkedAt": "2026-11-08T10:00:00.000Z",
                "mentioned": false,
                "position": 2,
                "runId": "run-2",
                "status": "cited",
              },
            ],
            "rate": 0.5,
            "valid": 2,
          },
          {
            "cited": 0,
            "engine": "perplexity",
            "points": [
              {
                "checkedAt": "2026-11-01T10:00:00.000Z",
                "mentioned": false,
                "position": null,
                "runId": "run-1",
                "status": "not_cited",
              },
              {
                "checkedAt": "2026-11-08T10:00:00.000Z",
                "mentioned": false,
                "position": null,
                "runId": "run-2",
                "status": "error",
              },
            ],
            "rate": 0,
            "valid": 1,
          },
        ],
        "placements": [
          {
            "id": "t-1",
            "publishedAt": "2026-11-02T00:00:00.000Z",
            "publishedUrl": "https://reddit.com/r/seo/1/c",
            "status": "published_manually",
            "surface": "reddit",
            "title": "Which tool?",
            "url": "https://reddit.com/r/seo/1",
          },
        ],
        "probes": [
          {
            "answerExcerpt": "An answer.",
            "checkedAt": "2026-11-08T10:00:00.000Z",
            "cited": true,
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "gemini",
            "error": null,
            "id": "p-3",
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": 2,
            "probeVersion": 1,
            "query": "best ai seo tool",
            "queryId": "q-1",
            "runId": "run-2",
            "sourceUrl": "https://acme.test/ai-seo",
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "cited",
          },
          {
            "answerExcerpt": null,
            "checkedAt": "2026-11-08T10:00:00.000Z",
            "cited": null,
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "perplexity",
            "error": "timeout",
            "id": "p-4",
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": null,
            "probeVersion": 1,
            "query": "best ai seo tool",
            "queryId": "q-1",
            "runId": "run-2",
            "sourceUrl": null,
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "error",
          },
          {
            "answerExcerpt": "An answer.",
            "checkedAt": "2026-11-01T10:00:00.000Z",
            "cited": false,
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "gemini",
            "error": null,
            "id": "p-1",
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": null,
            "probeVersion": 1,
            "query": "best ai seo tool",
            "queryId": "q-1",
            "runId": "run-1",
            "sourceUrl": null,
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "not_cited",
          },
          {
            "answerExcerpt": "An answer.",
            "checkedAt": "2026-11-01T10:00:00.000Z",
            "cited": false,
            "cluster": "basics",
            "competitors": [
              {
                "domain": "rival.test",
                "name": "Rival",
                "via": "source",
              },
            ],
            "engine": "perplexity",
            "error": null,
            "id": "p-2",
            "latencyMs": 900,
            "mentioned": false,
            "model": null,
            "position": null,
            "probeVersion": 1,
            "query": "best ai seo tool",
            "queryId": "q-1",
            "runId": "run-1",
            "sourceUrl": null,
            "sources": [
              {
                "domain": "rival.test",
                "title": "Rival",
                "url": "https://rival.test/a",
              },
            ],
            "status": "not_cited",
          },
        ],
        "query": {
          "cluster": "basics",
          "createdAt": "2026-10-01T00:00:00.000Z",
          "enabled": true,
          "id": "q-1",
          "intent": "commercial",
          "query": "best ai seo tool",
          "source": "manual",
        },
        "sources": [
          {
            "count": 3,
            "domain": "rival.test",
            "title": "Rival",
            "url": "https://rival.test/a",
          },
        ],
      }
    `);
    const foreign = await queryDetail(new Request("https://gettrafficfa.st") as never, { params: Promise.resolve({ id: "q-9" }) });
    expect(foreign.status).toBe(404);
  });
});

describe("GET /api/visibility/settings", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    const response = await settings();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "business": {
          "name": "Acme",
          "websiteUrl": "https://acme.test",
        },
        "configuredEngines": [
          "gemini",
          "perplexity",
        ],
        "identity": {
          "brandNames": [
            "Acme",
          ],
          "domains": [
            "acme.test",
            "blog.acme.test",
          ],
        },
        "settings": {
          "brandNames": [
            "Acme",
          ],
          "cadence": "weekly",
          "domains": [
            "blog.acme.test",
          ],
          "engines": [],
          "maxQueriesPerRun": 20,
          "placesFromSources": true,
        },
      }
    `);
  });

  it("answers 409 with no site", async () => {
    m.businessId = null;
    expect((await settings()).status).toBe(409);
  });
});

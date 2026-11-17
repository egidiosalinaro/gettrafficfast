import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_VERSION } from "@/lib/tools/mcp";
import { SITE_URL } from "@/lib/site";

/**
 * distribution/mcp/server*.json are what the owner publishes to the official
 * MCP Registry (docs/API.md, "Distribution"). They hold the registry's own
 * limits (schema 2025-12-11) and stay in step with the server: its version,
 * its URL, and icons that this site really serves.
 */

const ROOT = process.cwd();
const FILES = ["server.json", "server.github.json"] as const;

interface ServerJson {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  icons: { src: string; mimeType: string; sizes: string[] }[];
  remotes: { type: string; url: string }[];
}

const read = (file: string) => JSON.parse(readFileSync(join(ROOT, "distribution/mcp", file), "utf8")) as ServerJson;

describe.each(FILES)("distribution/mcp/%s", (file) => {
  const server = read(file);

  it("keeps the registry's limits", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
  });

  it("is the server as deployed: its version and its one remote", () => {
    expect(server.version).toBe(MCP_SERVER_VERSION);
    expect(server.remotes).toEqual([{ type: "streamable-http", url: `${SITE_URL}/api/mcp` }]);
    expect(server.websiteUrl.startsWith(SITE_URL)).toBe(true);
  });

  it("names icons this site serves from public/", () => {
    for (const icon of server.icons) {
      expect(icon.src.startsWith(`${SITE_URL}/brand/`)).toBe(true);
      expect(existsSync(join(ROOT, "public", icon.src.slice(SITE_URL.length)))).toBe(true);
    }
  });
});

it("the two namespace options differ only by name", () => {
  const [domain, github] = FILES.map(read);
  expect(domain.name).toBe("st.gettrafficfa/gettrafficfast");
  expect(github.name).toBe("io.github.egidiosalinaro/gettrafficfast");
  expect({ ...domain, name: "" }).toEqual({ ...github, name: "" });
});

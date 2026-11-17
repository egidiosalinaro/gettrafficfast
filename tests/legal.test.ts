import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISABLED_INTEGRATIONS,
  formatLegalDate,
  LEGAL_LAST_UPDATED,
  operatorAddressLine,
  PROVIDER_MODULES,
  PUBLIC_SOURCES,
  SERVICE_PROVIDERS,
  vatNumberLine,
} from "@/lib/legal";

/**
 * The facts the legal pages state (lib/legal.ts). Pinned: the date is a
 * fixed constant, never the render date; the VAT line disappears when the
 * number is empty; and the disclosed providers stay tied to the code, so a
 * vendor cannot be added under lib/providers without being classified, nor
 * stay listed after its code is gone.
 */

const ROOT = path.resolve(__dirname, "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

describe("last updated", () => {
  it("is a fixed ISO date, not computed", () => {
    expect(LEGAL_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatLegalDate("2026-11-17")).toBe("17 November 2026");
    const source = read("lib/legal.ts");
    expect(source).toMatch(/export const LEGAL_LAST_UPDATED = "\d{4}-\d{2}-\d{2}";/);
  });

  it("the pages print the constant, never the date of the render", () => {
    for (const file of [
      "app/privacy-policy/page.tsx",
      "app/terms-and-conditions/page.tsx",
      "components/legal/legal-page.tsx",
    ]) {
      expect(read(file)).not.toMatch(/new Date\(/);
    }
    expect(read("components/legal/legal-page.tsx")).toContain("LEGAL_LAST_UPDATED");
  });
});

describe("operator and VAT", () => {
  it("states the operator's address", () => {
    expect(operatorAddressLine()).toBe("Via Baccina 87, 00184 Roma, Italy");
  });

  it("omits the VAT line when the number is empty or blank", () => {
    expect(vatNumberLine("")).toBeNull();
    expect(vatNumberLine("   ")).toBeNull();
    expect(vatNumberLine(null)).toBeNull();
  });

  it("prints the operator's own number by default", () => {
    expect(vatNumberLine()).toBe("VAT number (Partita IVA): 18573881002");
  });

  it("prints the number when there is one", () => {
    expect(vatNumberLine(" 12345678901 ")).toBe("VAT number (Partita IVA): 12345678901");
  });

  it("the pages and the footer print the line only through vatNumberLine", () => {
    for (const file of [
      "app/privacy-policy/page.tsx",
      "app/terms-and-conditions/page.tsx",
      "components/landing/footer.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("vatNumberLine()");
      expect(source).not.toContain("LEGAL_VAT_NUMBER");
      expect(source).not.toMatch(/Partita IVA/);
    }
  });
});

describe("service providers match the code", () => {
  const providerFiles = filesUnder(path.join(ROOT, "lib/providers"))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".ts"))
    .sort();

  it("classifies every file under lib/providers", () => {
    expect(providerFiles.filter((file) => !(file in PROVIDER_MODULES))).toEqual([]);
  });

  it("classifies no file that is gone", () => {
    expect(Object.keys(PROVIDER_MODULES).filter((file) => !providerFiles.includes(file))).toEqual([]);
  });

  it("points every classification at a disclosed provider, source or disabled integration", () => {
    const providers = new Set(SERVICE_PROVIDERS.map((p) => p.id));
    const sources = new Set(PUBLIC_SOURCES.map((s) => s.id));
    const disabled = new Set(DISABLED_INTEGRATIONS.map((d) => d.id));
    for (const [file, disclosure] of Object.entries(PROVIDER_MODULES)) {
      if (disclosure.kind === "provider") for (const id of disclosure.ids) expect(providers, file).toContain(id);
      if (disclosure.kind === "source") for (const id of disclosure.ids) expect(sources, file).toContain(id);
      if (disclosure.kind === "disabled") expect(disabled, file).toContain(disclosure.id);
    }
  });

  it("a vendor file that fetches a host is not filed as internal", () => {
    for (const [file, disclosure] of Object.entries(PROVIDER_MODULES)) {
      if (disclosure.kind !== "internal") continue;
      const source = read(file);
      // Internal files may name hosts in comments; a literal https URL in code is a vendor call.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/["'`]https:\/\/(?!gettrafficfa\.st)[a-z0-9.-]+/i);
    }
  });

  it("every listed provider and disabled integration is still used by the code it names", () => {
    for (const entry of [...SERVICE_PROVIDERS, ...DISABLED_INTEGRATIONS]) {
      expect(read(entry.evidence.file), `${entry.id}: ${entry.evidence.file}`).toContain(entry.evidence.contains);
    }
  });

  it("every service provider has a purpose, the data it gets, and a privacy page", () => {
    for (const provider of SERVICE_PROVIDERS) {
      expect(provider.purpose.length).toBeGreaterThan(10);
      expect(provider.data.length).toBeGreaterThan(10);
      expect(provider.privacyUrl).toMatch(/^https:\/\//);
    }
    expect(new Set(SERVICE_PROVIDERS.map((p) => p.id)).size).toBe(SERVICE_PROVIDERS.length);
  });
});

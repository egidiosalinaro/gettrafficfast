import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_EMAIL } from "@/lib/site";

/**
 * The product used to advertise two inboxes (hello@gettrafficfast.com on the
 * footer and legal pages, hello@gettrafficfa.st on Settings → Business) and
 * neither had a mailbox. The one public inbox is declared once in
 * lib/site.ts, from NEXT_PUBLIC_CONTACT_EMAIL.
 */
const LEFTOVER_INBOX =
  /hello@gettrafficfast\.com|hello@gettrafficfa\.st/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkTsFiles(path));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("CONTACT_EMAIL", () => {
  it("is the one public inbox, from the environment, with a placeholder when unset", () => {
    expect(CONTACT_EMAIL).toBe(process.env.NEXT_PUBLIC_CONTACT_EMAIL || "support@example.com");
    expect(CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it("is the address the product UI advertises", () => {
    const files = [...walkTsFiles("app"), ...walkTsFiles("components")];
    const offenders = files.filter((file) =>
      LEFTOVER_INBOX.test(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});

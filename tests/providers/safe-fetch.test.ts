import { describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  isPublicAddress,
  safeFetch,
  type LookupAll,
  type Transport,
} from "@/lib/providers/safe-fetch";

/**
 * The fetch every customer-typed URL goes through. These tests never touch
 * the network: the resolver and the transport are stubbed, so what is under
 * test is the decision, hop by hop, not someone's DNS.
 */

const PUBLIC_IP = "93.184.216.34";

/** A resolver with a fixed table; unknown names do not resolve. */
function resolver(table: Record<string, string[]>): LookupAll {
  return async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    }
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

/** A transport that answers from a script and records every URL it was asked for. */
function scripted(answers: Record<string, () => Response>) {
  const seen: string[] = [];
  const transport: Transport = async (url) => {
    seen.push(url.toString());
    const answer = answers[url.toString()];
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return answer();
  };
  return { transport, seen };
}

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("isPublicAddress", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([PUBLIC_IP, "8.8.8.8", "2606:4700:4700::1111"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("safeFetch", () => {
  const never: Transport = async () => {
    throw new Error("the transport must not be reached");
  };

  it("refuses a private IP literal before connecting", async () => {
    await expect(safeFetch("http://10.0.0.1/", {}, { transport: never })).rejects.toBeInstanceOf(
      BlockedAddressError
    );
  });

  it("refuses the cloud metadata endpoint", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/", {}, { transport: never })
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("refuses localhost, resolved by the real resolver", async () => {
    await expect(safeFetch("http://localhost:3000/", {}, { transport: never })).rejects.toBeInstanceOf(
      BlockedAddressError
    );
  });

  it("refuses a public-looking name that resolves to a private address, even among public ones", async () => {
    const lookupAll = resolver({ "sneaky.example": [PUBLIC_IP, "192.168.0.10"] });
    await expect(
      safeFetch("https://sneaky.example/", {}, { lookupAll, transport: never })
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("refuses schemes other than http and https", async () => {
    await expect(safeFetch("file:///etc/passwd", {}, { transport: never })).rejects.toBeInstanceOf(
      BlockedAddressError
    );
    await expect(safeFetch("ftp://example.com/", {}, { transport: never })).rejects.toBeInstanceOf(
      BlockedAddressError
    );
  });

  it("refuses a redirect to a private IP, without requesting it", async () => {
    const lookupAll = resolver({ "public.example": [PUBLIC_IP] });
    const { transport, seen } = scripted({
      "https://public.example/hook": () => redirect("http://10.0.0.1/admin"),
    });
    await expect(
      safeFetch("https://public.example/hook", { method: "POST", body: "{}" }, { lookupAll, transport })
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(seen).toEqual(["https://public.example/hook"]);
  });

  it("refuses a redirect to a name that resolves privately", async () => {
    const lookupAll = resolver({ "public.example": [PUBLIC_IP], "internal.example": ["10.1.2.3"] });
    const { transport, seen } = scripted({
      "https://public.example/": () => redirect("https://internal.example/"),
    });
    await expect(safeFetch("https://public.example/", {}, { lookupAll, transport })).rejects.toBeInstanceOf(
      BlockedAddressError
    );
    expect(seen).toHaveLength(1);
  });

  it("hands back the redirect itself with redirect: manual, without following it", async () => {
    const lookupAll = resolver({ "public.example": [PUBLIC_IP] });
    const short = scripted({ "https://public.example/s": () => redirect("http://10.0.0.1/admin", 301) });
    const res = await safeFetch("https://public.example/s", { redirect: "manual" }, { lookupAll, transport: short.transport, maxRedirects: 0 });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://10.0.0.1/admin");
    expect(short.seen).toEqual(["https://public.example/s"]);
  });

  it("follows public redirects, and stops after five", async () => {
    const lookupAll = resolver({ "public.example": [PUBLIC_IP] });
    const answers: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) {
      answers[`https://public.example/${i}`] = () => redirect(`/${i + 1}`, 301);
    }
    answers["https://public.example/3"] = () => new Response("ok", { status: 200 });
    const short = scripted(answers);
    const res = await safeFetch("https://public.example/0", {}, { lookupAll, transport: short.transport });
    expect(await res.text()).toBe("ok");
    expect(short.seen).toHaveLength(4);

    delete answers["https://public.example/3"];
    answers["https://public.example/3"] = () => redirect("/4", 301);
    const long = scripted(answers);
    await expect(
      safeFetch("https://public.example/0", {}, { lookupAll, transport: long.transport })
    ).rejects.toThrow(/Too many redirects/);
    expect(long.seen).toHaveLength(6);
  });

  it("drops the Authorization header when a redirect changes origin", async () => {
    const lookupAll = resolver({ "a.example": [PUBLIC_IP], "b.example": [PUBLIC_IP] });
    const headersSeen: Record<string, string>[] = [];
    const transport: Transport = async (url, request) => {
      headersSeen.push(request.headers);
      return url.host === "a.example" ? redirect("https://b.example/") : new Response("ok");
    };
    await safeFetch("https://a.example/", { headers: { Authorization: "Basic abc" } }, { lookupAll, transport });
    expect(headersSeen[0].authorization).toBe("Basic abc");
    expect(headersSeen[1].authorization).toBeUndefined();
  });

  it("reports a name that does not resolve the way fetch does, for the existing error wording", async () => {
    const lookupAll = resolver({});
    const err = await safeFetch("https://nowhere.example/", {}, { lookupAll, transport: never }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TypeError);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("ENOTFOUND");
  });

  it("times out as an AbortError", async () => {
    const lookupAll = resolver({ "slow.example": [PUBLIC_IP] });
    const transport: Transport = (_url, _request, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const err = await safeFetch("https://slow.example/", {}, { lookupAll, transport, timeoutMs: 20 }).catch(
      (e: unknown) => e
    );
    expect((err as Error).name).toBe("AbortError");
  });
});

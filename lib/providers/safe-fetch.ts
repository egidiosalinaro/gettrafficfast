import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

/**
 * Fetch for URLs a customer typed.
 *
 * The platform fetches addresses it did not choose: a site to analyse, a
 * webhook to deliver to, a WordPress install. Plain `fetch` will happily reach
 * 127.0.0.1, the VPC, or the cloud metadata endpoint at 169.254.169.254 on
 * the server's behalf, and hand the answer back. This is the one way those
 * URLs are fetched:
 *
 *   - http and https only;
 *   - every address the host resolves to must be public. Private, loopback,
 *     link-local, CGNAT, multicast, documentation and metadata ranges are
 *     refused, IPv4 and IPv6 alike;
 *   - the check runs again INSIDE the socket's own DNS lookup, so the address
 *     that was checked is the address connected to: a name that resolves to a
 *     public IP for the check and a private one for the connection (DNS
 *     rebinding) is still refused;
 *   - redirects are followed by hand, at most MAX_REDIRECTS, each hop checked
 *     the same way, with credentials dropped when the origin changes;
 *   - one deadline for the whole exchange, and a ceiling on the body size.
 */

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const blocked = new BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network
blocked.addSubnet("10.0.0.0", 8, "ipv4"); // private
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
blocked.addSubnet("172.16.0.0", 12, "ipv4"); // private
blocked.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
blocked.addSubnet("192.0.2.0", 24, "ipv4"); // documentation
blocked.addSubnet("192.88.99.0", 24, "ipv4"); // 6to4 relay
blocked.addSubnet("192.168.0.0", 16, "ipv4"); // private
blocked.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocked.addSubnet("198.51.100.0", 24, "ipv4"); // documentation
blocked.addSubnet("203.0.113.0", 24, "ipv4"); // documentation
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, broadcast
// IPv6. No rule for ::ffff:0:0/96: BlockList checks a v4-mapped address
// against the IPv4 rules above (and such a rule would match every IPv4).
blocked.addSubnet("::", 96, "ipv6"); // unspecified, loopback, v4-compatible
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64, embeds a v4 address
blocked.addSubnet("64:ff9b:1::", 48, "ipv6"); // local NAT64
blocked.addSubnet("100::", 64, "ipv6"); // discard
blocked.addSubnet("2001:db8::", 32, "ipv6"); // documentation
blocked.addSubnet("2002::", 16, "ipv6"); // 6to4, embeds a v4 address
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local (incl. fd00:ec2::254 metadata)
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("fec0::", 10, "ipv6"); // site-local (deprecated)
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast

/** True when `address` (an IP literal) is somewhere a customer URL may point. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return !blocked.check(bare, "ipv4");
  if (family === 6) return !blocked.check(bare, "ipv6");
  return false;
}

/** Thrown when a URL, or a hop of its redirects, is not a public http(s) address. */
export class BlockedAddressError extends Error {
  readonly code = "EBLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

const systemLookupAll: LookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function assertProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(`Only http and https addresses can be fetched (${url.protocol})`);
  }
}

/**
 * Resolves the URL's host and refuses it unless every address is public.
 * Every address, not the first: a resolver hands them out in any order.
 */
export async function assertPublicUrl(url: URL, lookupAll: LookupAll = systemLookupAll): Promise<void> {
  assertProtocol(url);
  const host = hostOf(url);
  if (!host) throw new BlockedAddressError("The address has no host");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedAddressError(`${host} is not a public address`);
    return;
  }
  const addresses = await lookupAll(host);
  if (addresses.length === 0) throw new BlockedAddressError(`${host} did not resolve`);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw new BlockedAddressError(`${host} resolves to a non-public address`);
}

export interface TransportRequest {
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/** One HTTP exchange, no redirects. Injectable so tests never touch the network. */
export type Transport = (
  url: URL,
  request: TransportRequest,
  options: { signal: AbortSignal; lookupAll: LookupAll; maxBytes: number }
) => Promise<Response>;

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function decode(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      return zlib.inflateSync(body);
    case "br":
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

/**
 * The default transport: node's http client with the address check inside
 * the socket's lookup, so the connection can only ever reach an address that
 * passed it.
 */
export const nodeTransport: Transport = (url, request, { signal, lookupAll, maxBytes }) =>
  new Promise<Response>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;

    const pinnedLookup = (
      hostname: string,
      options: { all?: boolean },
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number
      ) => void
    ) => {
      lookupAll(hostname)
        .then((addresses) => {
          const bad = addresses.find((a) => !isPublicAddress(a.address));
          if (addresses.length === 0 || bad) {
            callback(new BlockedAddressError(`${hostname} resolves to a non-public address`), "");
            return;
          }
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        })
        .catch((err) => callback(err as NodeJS.ErrnoException, ""));
    };

    const req = client.request(
      url,
      {
        method: request.method,
        // A known length rather than chunked encoding, as fetch sends it.
        headers: request.body
          ? { ...request.headers, "content-length": String(request.body.length) }
          : request.headers,
        agent: false,
        lookup: pinnedLookup as never,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`Response from ${url.host} is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const status = res.statusCode ?? 502;
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              const lower = name.toLowerCase();
              // The body below is already decoded and complete.
              if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") {
                continue;
              }
              for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
            }
            const raw = Buffer.concat(chunks);
            const body = NULL_BODY_STATUS.has(status)
              ? null
              : decode(raw, res.headers["content-encoding"] as string | undefined);
            resolve(
              new Response(body ? new Uint8Array(body) : null, {
                status: status < 200 || status > 599 ? 502 : status,
                statusText: res.statusMessage ?? "",
                headers,
              })
            );
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (request.body) req.write(request.body);
    req.end();
  });

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  /** Test seams. Production uses the system resolver and node's http client. */
  lookupAll?: LookupAll;
  transport?: Transport;
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

const SENSITIVE_ON_CROSS_ORIGIN = ["authorization", "cookie", "proxy-authorization"];

/**
 * `fetch`, for addresses a customer supplied. Same Response back; refuses
 * (BlockedAddressError) instead of reaching anything that is not public.
 * Network failures are thrown the way `fetch` throws them (a TypeError whose
 * `cause` carries the code), so existing error wording keeps working.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lookupAll = options.lookupAll ?? systemLookupAll;
  const transport = options.transport ?? nodeTransport;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    clearTimeout(timer);
    throw new BlockedAddressError("Not a valid URL");
  }

  let method = (init.method ?? "GET").toUpperCase();
  const headers = headersToRecord(init.headers);
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";
  let body = await bodyToBuffer(init.body);

  try {
    for (let hop = 0; ; hop++) {
      if (controller.signal.aborted) throw abortError(`Timed out after ${timeoutMs} ms`);
      try {
        await assertPublicUrl(url, lookupAll);
      } catch (err) {
        if (err instanceof BlockedAddressError) throw err;
        // A name that does not resolve: reported like fetch reports it.
        throw new TypeError("fetch failed", { cause: err });
      }

      let res: Response;
      try {
        res = await transport(url, { method, headers: { ...headers }, body }, {
          signal: controller.signal,
          lookupAll,
          maxBytes,
        });
      } catch (err) {
        if (err instanceof BlockedAddressError) throw err;
        if (controller.signal.aborted) throw abortError(`Timed out after ${timeoutMs} ms`);
        throw new TypeError("fetch failed", { cause: err });
      }

      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || res.status === 304 || !location) return res;
      // `redirect: "manual"`: the redirect itself is the answer (a short
      // link read for where it points, never followed there).
      if (init.redirect === "manual") return res;

      if (hop >= maxRedirects) {
        throw new BlockedAddressError(`Too many redirects (more than ${maxRedirects})`);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new BlockedAddressError("A redirect pointed at an invalid URL");
      }
      if (next.origin !== url.origin) {
        for (const name of SENSITIVE_ON_CROSS_ORIGIN) delete headers[name];
      }
      // fetch's own rules: 303 always, and 301/302 after a POST, become a GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = null;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      url = next;
    }
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

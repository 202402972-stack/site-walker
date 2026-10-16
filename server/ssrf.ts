// SSRF guard — plan §8.1. Required, not optional.
// Allow only http/https. Reject credentials, private IPs, metadata IPs,
// numeric/hex/octal spellings, localhost, *.internal, *.railway.internal.
// Applied to the entry URL AND every request Chromium makes + every redirect.
import dns from "node:dns/promises";
import net from "node:net";

export const BLOCKED_SUFFIXES = [".internal", ".railway.internal"];

export function stripBrackets(h: string): string {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (h === "localhost") return true;
  if (h === "metadata.google.internal") return true;
  for (const s of BLOCKED_SUFFIXES) if (h === s.slice(1) || h.endsWith(s)) return true;
  return false;
}

// Detect decimal / hex / octal / mixed IP spellings that URL/hostname parsing
// might otherwise treat as non-IP hostnames (e.g. 0x7f.0x0.0x0.0x1, 2130706433).
export function looksLikeNumericIp(host: string): boolean {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  const partRe = /^(0x[0-9a-fA-F]+|0[0-7]*|[0-9]+)$/;
  if (!parts.every((p) => partRe.test(p))) return false;
  // All-numeric dotted form — treat as IP spelling attempt, resolve via parse below.
  return true;
}

export function parseIpv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-9]+$/.test(p) && p.length > 1) {
      if (/[^0-7]/.test(p.slice(1))) return null;
      n = parseInt(p, 8);
    } else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  if (nums.length === 1) return nums[0] >>> 0;
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    return (((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3]) >>> 0;
  }
  return null; // shorthand a.b.c forms — reject as ambiguous
}

function ipv4IntToBytes(n: number): [number, number, number, number] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function isBlockedIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 ::ffff:a.b.c.d (dotted or hex like ::ffff:7f00:1).
  let v: string = stripBrackets(ip.toLowerCase());
  const mappedDotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) v = mappedDotted[1];
  else {
    const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      v = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    } else if (v.startsWith("::ffff:")) v = v.slice(7);
  }

  if (net.isIP(v) === 0) {
    // Might be a numeric spelling — try to normalize to dotted quad.
    const n = parseIpv4ToInt(v);
    if (n === null) return true; // unparseable where IP expected → block
    v = ipv4IntToBytes(n).join(".");
  }
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a === 0) return true; // unspecified / software scope
    if (a >= 224 && a <= 239) return true; // multicast
    if (a >= 240) return true; // reserved
    if (a === 192 && b === 0 && v.startsWith("192.0.2.")) return true; // TEST-NET-1
    if (v.startsWith("198.51.100.")) return true; // TEST-NET-2
    if (v.startsWith("203.0.113.")) return true; // TEST-NET-3
    if (a === 192 && b === 88 && v.startsWith("192.88.99.")) return true; // 6to4 relay (deprecated)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && v.startsWith("192.0.0.")) return true;
    return false;
  }
  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80:") || v.startsWith("fe90:") || v.startsWith("fea") || v.startsWith("feb")) return true; // link-local fe80/10
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local fc00/7
    if (v.startsWith("ff")) return true; // multicast
    // IPv4-mapped forms already normalized; 6to4 / teredo map to v4 checks above roughly.
    if (v.includes(".")) return true; // any residual dotted v6 → block conservatively
    return false;
  }
  return true;
}

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "URL_INVALID" | "URL_BLOCKED"; message: string };

export async function validateEntryUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "URL_INVALID", message: "URL is not parseable." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "URL_BLOCKED", message: "Only http and https are allowed." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "URL_BLOCKED", message: "Credentials in URL are not allowed." };
  }
  const host = stripBrackets(url.hostname);
  if (!host) return { ok: false, code: "URL_INVALID", message: "URL has no host." };
  if (isBlockedHostname(stripBrackets(host))) {
    return { ok: false, code: "URL_BLOCKED", message: "Host is blocked (local/internal)." };
  }
  // Numeric spellings: normalize or block even before DNS.
  if (looksLikeNumericIp(host) || net.isIP(host) !== 0) {
    const candidate = net.isIP(host) !== 0 ? host : (() => {
      const n = parseIpv4ToInt(host);
      return n === null ? null : ipv4IntToBytes(n).join(".");
    })();
    if (candidate === null || isBlockedIp(candidate)) {
      return { ok: false, code: "URL_BLOCKED", message: "IP literal is private/loopback or ambiguous." };
    }
  }
  // DNS resolve every A/AAAA and block if ANY record is private.
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.length === 0) return { ok: false, code: "URL_INVALID", message: "Host does not resolve." };
    for (const r of records) {
      if (isBlockedIp(r.address)) {
        return { ok: false, code: "URL_BLOCKED", message: `Host resolves to blocked address (${r.address}).` };
      }
    }
  } catch {
    return { ok: false, code: "URL_INVALID", message: "Host does not resolve." };
  }
  return { ok: true, url };
}

// Synchronous per-request check for Playwright route interception (no DNS async
// on hot path — blocks literals/hostnames; entry + redirect hops get full async check).
export function shouldBlockRequestUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  const proto: string = url.protocol;
  if (proto !== "http:" && proto !== "https:") return true;
  const host = stripBrackets(url.hostname);
  if (!host) return true;
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host) !== 0 && isBlockedIp(host)) return true;
  if (looksLikeNumericIp(host)) {
    const n = parseIpv4ToInt(host);
    if (n === null) return true;
    if (isBlockedIp(ipv4IntToBytes(n).join("."))) return true;
  }
  return false;
}

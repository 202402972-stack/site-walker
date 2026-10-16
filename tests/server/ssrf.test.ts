import { describe, it, expect } from "vitest";
import { isBlockedIp, shouldBlockRequestUrl, isBlockedHostname } from "../../server/ssrf.js";

describe("SSRF guard (A6)", () => {
  it("blocks loopback, private, link-local, CGNAT, multicast", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.9.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "::1", "100.64.0.1", "224.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("allows public IPs", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
  it("blocks numeric spellings + ipv4-mapped", () => {
    expect(shouldBlockRequestUrl("http://2130706433/")).toBe(true);
    expect(shouldBlockRequestUrl("http://0x7f.0x0.0x0.0x1/")).toBe(true);
    expect(shouldBlockRequestUrl("http://[::ffff:127.0.0.1]/")).toBe(true);
    expect(shouldBlockRequestUrl("http://[::1]/")).toBe(true);
  });
  it("blocks hostnames + schemes", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("x.internal")).toBe(true);
    expect(isBlockedHostname("x.railway.internal")).toBe(true);
    expect(shouldBlockRequestUrl("file:///etc/passwd")).toBe(true);
    expect(shouldBlockRequestUrl("ftp://example.com/")).toBe(true);
  });
});

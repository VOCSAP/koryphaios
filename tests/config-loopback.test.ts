import { test, expect } from "bun:test";
import { bindHostRefusal, isLoopbackBrokerUrl } from "../shared/config.ts";

// Bug F: server.ts ensureBroker() must skip spawning a local broker when the
// configured BROKER_URL points to a remote host. isLoopbackBrokerUrl is the
// gate that distinguishes local-only deployment from HTTP-remote deployment.

test("isLoopbackBrokerUrl accepts 127.0.0.1 with port", () => {
  expect(isLoopbackBrokerUrl("http://127.0.0.1:7899")).toBe(true);
});

test("isLoopbackBrokerUrl accepts localhost", () => {
  expect(isLoopbackBrokerUrl("http://localhost:7899")).toBe(true);
});

test("isLoopbackBrokerUrl accepts IPv6 loopback in brackets", () => {
  expect(isLoopbackBrokerUrl("http://[::1]:7899")).toBe(true);
});

test("isLoopbackBrokerUrl rejects LAN IPv4 (HTTP remote)", () => {
  expect(isLoopbackBrokerUrl("http://192.0.2.23:7899")).toBe(false);
});

test("isLoopbackBrokerUrl rejects public DNS name", () => {
  expect(isLoopbackBrokerUrl("https://broker.example.com")).toBe(false);
});

test("isLoopbackBrokerUrl rejects malformed URL", () => {
  expect(isLoopbackBrokerUrl("not-a-url")).toBe(false);
});

test("isLoopbackBrokerUrl is case-insensitive on hostname", () => {
  expect(isLoopbackBrokerUrl("http://LocalHost:7899")).toBe(true);
});

test("bindHostRefusal lets a loopback or unset bind host start without a token", () => {
  for (const host of [null, "127.0.0.1", "127.0.0.2", "localhost", "LocalHost", "::1", "[::1]"]) {
    expect(bindHostRefusal(host, null), `bind host ${String(host)}`).toBeNull();
  }
});

test("bindHostRefusal refuses a bind host beyond loopback without a token", () => {
  for (const host of ["0.0.0.0", "::", "192.0.2.23", "broker.example.com", ""]) {
    const reason = bindHostRefusal(host, null);
    expect(reason, `bind host ${JSON.stringify(host)}`).toContain("CLAUDE_PEERS_BROKER_TOKEN");
  }
  expect(bindHostRefusal("0.0.0.0", "")).not.toBeNull();
});

test("bindHostRefusal lets a bind host beyond loopback start with a token", () => {
  expect(bindHostRefusal("0.0.0.0", "shared-secret")).toBeNull();
});

import { expect, test } from "bun:test";
import { isNetworkError } from "../src/model/index.ts";

test("errors that read as the network's get the proxy hint", () => {
  for (const m of [
    "net/http: TLS handshake timeout",
    "dial tcp: lookup googleapis.com: no such host",
    "request timed out",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "read ECONNRESET",
  ])
    expect(isNetworkError(m)).toBe(true);
  expect(isNetworkError("Invalid API key")).toBe(false);
  expect(isNetworkError(undefined)).toBe(false);
});

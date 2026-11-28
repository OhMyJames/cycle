import { expect, test } from "bun:test";
import { isNetworkError } from "../src/network.ts";

test("network-looking command output is a network error", () => {
  for (const out of [
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
    "ssh: connect to host github.com port 22: Connection timed out",
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    "dial tcp 140.82.112.5:443: i/o timeout",
    "fatal: the remote end hung up unexpectedly\nfatal: early EOF",
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "HTTP 503: Service Unavailable",
    "The requested URL returned error: 504",
    "gh pr view 失败（exit 1）：error connecting to api.github.com",
  ])
    expect(isNetworkError(out)).toBe(true);
});

test("authentication, missing branch, conflict and rejection are not network errors", () => {
  for (const out of [
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "fatal: couldn't find remote ref refs/heads/nope",
    "CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed",
    " ! [rejected]        HEAD -> auto/cyc-1 (non-fast-forward)",
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "boom",
    "",
  ])
    expect(isNetworkError(out)).toBe(false);
});

test("HTTP 400/422/429, SSL certificate and proxy errors, and a bare EOF word are not network errors", () => {
  for (const out of [
    "fatal: unable to access 'https://x/': The requested URL returned error: 400",
    "fatal: unable to access 'https://x/': SSL certificate problem: unable to get local issuer certificate",
    "fatal: unable to access 'https://x/': Proxy error",
    "HTTP 429: rate limited",
    "HTTP 422: Validation Failed",
    "unexpected token at end of file: EOF marker missing",
  ])
    expect(isNetworkError(out)).toBe(false);
  expect(isNetworkError("gh pr view 超时。")).toBe(true);
  expect(isNetworkError("fatal: early EOF")).toBe(true);
});

test("a reasonless remote rejection is a network error (CYC-559)", () => {
  expect(
    isNetworkError(
      "git push 失败：To https://github.com/OhMyJames/cycle\n ! [remote rejected]   67dc83e426dfda26de76abacfa2072de9f02c36c -> auto/cyc-526 (failed)\nerror: failed to push some refs to 'https://github.com/OhMyJames/cycle'",
    ),
  ).toBe(true);
  expect(isNetworkError(" ! [remote rejected] HEAD -> auto/cyc-1 (Internal Server Error)")).toBe(
    true,
  );
});

test("a remote rejection with a stated reason is not a network error", () => {
  for (const reason of [
    "protected branch hook declined",
    "pre-receive hook declined",
    "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
    "push declined due to repository rule violations",
    "secret scan blocked push",
  ])
    expect(
      isNetworkError(
        ` ! [remote rejected] HEAD -> auto/cyc-1 (${reason})\nerror: failed to push some refs to 'x'`,
      ),
    ).toBe(false);
});

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

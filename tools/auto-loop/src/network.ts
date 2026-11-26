// Which command failures are the network's fault (CYC-444). Only these are retried and, when the retries run out,
// wait instead of blocking. Permission, authentication, missing branch and merge conflicts are not network errors.

const NETWORK_PATTERNS: RegExp[] = [
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /connection reset/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /tls handshake timeout/i,
  /unable to access/i,
  /i\/o timeout/i,
  /\bEOF\b/,
  /\bHTTP:? ?50[234]\b/i,
  /\b50[234] (bad gateway|service unavailable|gateway time-?out)/i,
  /\b(bad gateway|service unavailable|gateway time-?out)\b/i,
  /error connecting to /i,
  /returned error: 50[234]/i,
  /the remote end hung up unexpectedly/i,
];

// What an authentication or permission failure looks like; these win over a network-looking line such as
// "fatal: unable to access '…': The requested URL returned error: 403".
const NOT_NETWORK_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /permission denied/i,
  /could not read from remote repository.*\n?.*(permission|rights)/i,
  /requested URL returned error: (401|403|404)/i,
  /\bHTTP 40[134]\b/i,
  /bad credentials/i,
  /couldn't find remote ref/i,
  /merge conflict/i,
  /\[rejected\]/,
  /non-fast-forward/i,
];

export const isNetworkError = (output: string): boolean => {
  if (NOT_NETWORK_PATTERNS.some((p) => p.test(output))) return false;
  return NETWORK_PATTERNS.some((p) => p.test(output));
};

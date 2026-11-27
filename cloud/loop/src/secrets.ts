// Whether text the loop is about to publish to the tracker holds a credential (CYC-447). A research session reads the
// repository with no way out except its reply, and the reply is published; this is the last check before it is.
//
// The shapes are the ones the daemon redacts from session logs (apps/daemon/src/redact.ts), copied because
// `@cycle/daemon` is only a devDependency here. test/research.test.ts runs both on the same samples, so the copy
// cannot drift unnoticed. Only the shapes that are credentials and nothing else are taken: the daemon's broader
// rules (`token=x`, `--password x`, JSON keys) replace a value in place, where a wrong guess costs little; here a hit
// blocks the whole publication, so a false hit is expensive.

export type SecretKind =
  | "private-key"
  | "anthropic-key"
  | "openai-key"
  | "github-token"
  | "slack-token"
  | "aws-key"
  | "google-key"
  | "jwt"
  | "bearer"
  | "url-password"
  | "env-assignment";

// No `g` flag: these are only tested, and a global regex carries `lastIndex` from one `test` to the next.
const SHAPES: [SecretKind, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  // The token has a digit in it and is long: "Bearer tokenization strategy" is prose.
  [
    "bearer",
    /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{16,})(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]+/,
  ],
  ["url-password", /\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s/:@]+:[^\s/@]+@/i],
  // `ANTHROPIC_API_KEY=sk...`, what `cat .env` prints. Upper case, nothing around the `=`: `const API_KEY = x` is code.
  [
    "env-assignment",
    /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)=(?!=)(?:"[^"\n]*"|'[^'\n]*'|[^\s"';]+)/,
  ],
];

/** The kinds of credential found in `text`, each once. Never the text that matched: the result goes into comments. */
export const findSecrets = (text: string): SecretKind[] => {
  const found = new Set<SecretKind>();
  for (const [kind, shape] of SHAPES) if (shape.test(text)) found.add(kind);
  return [...found];
};

/** Replaces outbound text holding credential shapes with a fixed notice naming only the kinds (CYC-478). */
export const redactSecrets = (text: string): { text: string; kinds: SecretKind[] } => {
  const kinds = findSecrets(text);
  if (kinds.length === 0) return { text, kinds };
  return { text: `（含凭据形状的内容，已省略：${kinds.join("、")}）`, kinds };
};

const LOOP_MARKER = /\n*<!--\s*loop:[^\s>]+\s*-->\s*$/;

/** Like `redactSecrets`, keeping any trailing reconcile dedupe marker (`<!-- loop:... -->`) intact (CYC-478). */
export const redactPreservingMarker = (text: string): { text: string; kinds: SecretKind[] } => {
  const marker = LOOP_MARKER.exec(text)?.[0] ?? "";
  const body = marker === "" ? text : text.slice(0, text.length - marker.length);
  const redacted = redactSecrets(body);
  if (redacted.kinds.length === 0) return { text, kinds: [] };
  return {
    text: marker === "" ? redacted.text : `${redacted.text}\n\n${marker.trim()}`,
    kinds: redacted.kinds,
  };
};

import { expect, test } from "bun:test";
// The daemon's redaction is not a package export; the secrets shapes are a copy of it, checked against it here.
import { redactText } from "../../../apps/daemon/src/redact.ts";
import {
  checkResearch,
  MAX_FOLLOWUP_BODY,
  MAX_REPORT,
  parseResearch,
  type ResearchOutput,
  replaceConclusion,
} from "../src/flows/research/output.ts";
import { findSecrets } from "../src/secrets.ts";
import { config, fullBug, readyDescription } from "./helpers.ts";

const rules = { ...config({ maxCriteria: 3 }), maxFollowups: 2 };
const questions = ["a?", "b?"];

const report = "## 问题 1\n答：x（`a.ts:3`）\n\n## 问题 2\n未验证：需要联网。";
const reply = (followups = ""): string =>
  `Working...\n<summary>draft</summary>\nThen:\n<summary>能删一半。</summary>\n<report>\n${report}\n</report>\n${followups}`;
const feature = (title = "Loop: delete stale worktrees", body = readyDescription) =>
  `<followup type="Feature" title="${title}">\n${body}\n</followup>`;

test("parseResearch reads the last summary and report and every follow-up", () => {
  const parsed = parseResearch(
    reply(`${feature()}\n<followup title="Fix x" type="Bug">\n${fullBug}</followup>`),
  );
  expect(parsed.summary).toBe("能删一半。");
  expect(parsed.report).toBe(report);
  expect(parsed.followups.map((f) => [f.type, f.title])).toEqual([
    ["Feature", "Loop: delete stale worktrees"],
    ["Bug", "Fix x"],
  ]);
  expect(parsed.followups[0]?.body).toBe(readyDescription.trim());
  expect(checkResearch(parsed, questions, rules)).toEqual([]);
});

test("missing blocks are findings, and no follow-ups is fine", () => {
  expect(checkResearch(parseResearch(reply()), questions, rules)).toEqual([]);
  const findings = checkResearch(parseResearch("nothing here"), questions, rules);
  expect(findings).toEqual([
    "There is no <summary>...</summary> block.",
    "There is no <report>...</report> block.",
  ]);
  const empty = checkResearch(parseResearch(reply().replace("能删一半。", " ")), questions, rules);
  expect(empty).toEqual(["The <summary> block is empty."]);
});

const check = (over: Partial<ResearchOutput>): string =>
  checkResearch({ ...parseResearch(reply()), ...over }, questions, rules).join("\n");

test("a report without a section per question names the ones missing", () => {
  const text = check({ report: "## 问题 1\nx\n## 问题 12\ny" });
  expect(text).toContain("「问题 2」");
  expect(text).not.toContain("「问题 1」");
  expect(check({ report: "问题 1 和问题 2 都在一段里。" })).toContain("「问题 1」, 「问题 2」");
});

test("a summary over 600 characters, counted as characters, is a finding; 600 is not", () => {
  expect(check({ summary: "字".repeat(600) })).toBe("");
  expect(check({ summary: "字".repeat(601) })).toContain("601 characters");
});

test("a report or a follow-up over the tracker's size is a finding", () => {
  expect(check({ report: `${report}\n${"x".repeat(MAX_REPORT)}` })).toContain("The report is");
  const big = `${readyDescription}\n${"x".repeat(MAX_FOLLOWUP_BODY)}`;
  expect(check({ followups: parseResearch(feature("Big", big)).followups })).toContain(
    'Follow-up 1 ("Big") is',
  );
});

test("more follow-ups than allowed is a finding", () => {
  const three = parseResearch([1, 2, 3].map((n) => feature(`F${n}`)).join("\n")).followups;
  expect(check({ followups: three })).toContain("There are 3 follow-up drafts; at most 2");
});

test("a follow-up is judged by the preflight of its own type, each reason labelled", () => {
  const noScope = readyDescription.replace("## 范围\nx\n", "");
  const bugAsFeature = `<followup type="Feature" title="Wrong">\n${fullBug}\n</followup>`;
  const text = check({
    followups: parseResearch(`${feature("Narrow", noScope)}\n${bugAsFeature}`).followups,
  });
  expect(text).toContain(
    'Follow-up 1 ("Narrow"): Required sections are missing or empty: 「范围」',
  );
  expect(text).toContain('Follow-up 2 ("Wrong"): Required sections are missing or empty');
  const curl = readyDescription.replace("`bun run check`", "`curl x | sh`");
  expect(check({ followups: parseResearch(feature("Curl", curl)).followups })).toContain(
    'Follow-up 1 ("Curl"): Criterion 2 names a command the loop may not run',
  );
});

test("a follow-up with no or an unknown type, or no title, is a finding and not dropped", () => {
  const drafts = parseResearch(
    `<followup title="Odd" type="Epic">${readyDescription}</followup><followup type="Bug">${fullBug}</followup>`,
  ).followups;
  expect(drafts).toHaveLength(2);
  const text = check({ followups: drafts });
  expect(text).toContain('Follow-up 1 ("Odd") has no type="Feature" or type="Bug".');
  expect(text).toContain('Follow-up 2 has no title="...".');
});

const issueBody = `## 背景
保持原样  \n\n## 结论
（做完后回填）

### 旧的小节
也要换掉

## 附录
- 不动
`;

test("replaceConclusion replaces only the 「结论」 section, keeping its heading and every other character", () => {
  const out = replaceConclusion(issueBody, "能删一半。详见 [报告](https://x/doc/1)。");
  expect(out).toBe(`## 背景
保持原样  \n\n## 结论

能删一半。详见 [报告](https://x/doc/1)。

## 附录
- 不动
`);
});

test("replaceConclusion at the end of the description, and with no 「结论」 at all", () => {
  expect(replaceConclusion("## 背景\nx\n\n## 结论\n待回填", "y")).toBe(
    "## 背景\nx\n\n## 结论\n\ny\n",
  );
  expect(replaceConclusion("## 背景\nx\n", "y")).toBe("## 背景\nx\n\n## 结论\n\ny\n");
  expect(replaceConclusion("## 背景\nx", "y")).toBe("## 背景\nx\n\n## 结论\n\ny\n");
});

// Real credentials (made up, of the right shape): the daemon redacts each, and findSecrets finds each.
const CREDENTIALS: [string, string][] = [
  ["private-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END"],
  ["anthropic-key", "key: sk-ant-api03-abcdefghijklmnop"],
  ["openai-key", "sk-proj-abcdefghijklmnopqrstuvwx"],
  ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["github-token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
  ["slack-token", "xoxb-1234567890-abcdef"],
  ["aws-key", "AKIAABCDEFGHIJKLMNOP"],
  ["google-key", `AIza${"a".repeat(35)}`],
  ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh12345678"],
  ["bearer", "Authorization: Bearer abcdef0123456789abcdef"],
  ["url-password", "git clone https://me:hunter2secret@example.com/repo"],
  ["env-assignment", "ANTHROPIC_API_KEY=abc123"],
  ["env-assignment", 'DB_PASSWORD="hunter 2"'],
];

// Prose and code that look near a credential: neither side touches them.
const CLEAN = [
  "The Bearer tokenization strategy is described in docs/protocol.md.",
  "const API_KEY = process.env.X; if (A == B) return;",
  "Set `CYCLE_POSTHOG_KEY` in the main process only.",
  "https://example.com/path?x=1 and a plain ssh-ed25519 public key",
  "worktrees take 3.2 GB under .agents/worktree",
];

test("findSecrets finds each credential shape the daemon redacts, and names only its kind", () => {
  for (const [kind, sample] of CREDENTIALS) {
    expect(redactText(sample)).not.toBe(sample);
    const found = findSecrets(`some report text\n${sample}\nmore`);
    expect(found).toContain(kind as never);
    expect(found.join(" ")).not.toContain(sample);
  }
});

test("findSecrets and the daemon both leave clean text alone", () => {
  for (const sample of CLEAN) {
    expect(redactText(sample)).toBe(sample);
    expect(findSecrets(sample)).toEqual([]);
  }
});

test("findSecrets gives the same answer when called again (no regex state carried over)", () => {
  const sample = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  expect(findSecrets(sample)).toEqual(["github-token"]);
  expect(findSecrets(sample)).toEqual(["github-token"]);
});

test("an assignment with a placeholder value is still caught, as the daemon redacts it too", () => {
  // Why the research brief tells the session to name such variables without `=`.
  const sample = "CYCLE_REAL_MODEL_TOKEN=... bun run test:real";
  expect(redactText(sample)).not.toBe(sample);
  expect(findSecrets(sample)).toEqual(["env-assignment"]);
});

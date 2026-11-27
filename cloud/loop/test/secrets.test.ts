import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubForge } from "../src/ports/github.ts";
import { redactPreservingMarker, redactSecrets, type SecretKind } from "../src/secrets.ts";

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop() as string, { recursive: true, force: true });
  }
});

const LEAK_GH = "ghp_123456789012345678901234567890123456";
const LEAK_SLACK = "xoxb-1234567890-abcdefghijkl";

test("redactSecrets replaces credential-shaped text and leaves clean text untouched (CYC-478)", () => {
  expect(redactSecrets("普通说明文本，没有凭据。")).toEqual({
    text: "普通说明文本，没有凭据。",
    kinds: [],
  });
  const hit = redactSecrets(`泄漏了 ${LEAK_GH} 和 ${LEAK_SLACK}`);
  expect(hit.kinds).toEqual(["github-token", "slack-token"]);
  expect(hit.text).toBe("（含凭据形状的内容，已省略：github-token、slack-token）");
  expect(hit.text).not.toContain(LEAK_GH);
  expect(hit.text).not.toContain(LEAK_SLACK);
});

test("redactPreservingMarker keeps reconcile dedupe marker when redacting tracker comments (CYC-478)", () => {
  const hit = redactPreservingMarker(`错误输出：${LEAK_GH}\n\n<!-- loop:blocked:CYC-1:1 -->`);
  expect(hit.kinds).toEqual(["github-token"]);
  expect(hit.text).toBe(
    "（含凭据形状的内容，已省略：github-token）\n\n<!-- loop:blocked:CYC-1:1 -->",
  );
  expect(hit.text).not.toContain(LEAK_GH);
});

test("githubForge redacts PR body and PR comment files holding credentials and reports kinds (CYC-478)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-secrets-"));
  temps.push(dir);
  const redactedEvents: SecretKind[][] = [];
  const writtenBodies: string[] = [];

  const forge = githubForge({
    exec: async (argv) => {
      const idx = argv.indexOf("--body-file");
      if (idx !== -1 && argv[idx + 1] !== undefined) {
        writtenBodies.push(await readFile(argv[idx + 1] as string, "utf8"));
      }
      return { code: 0, output: "https://github.com/o/r/pull/1\n", timedOut: false };
    },
    env: { PATH: "/bin", GH_TOKEN: "t" },
    onRedact: (kinds) => redactedEvents.push(kinds),
  });

  const prBody = join(dir, "pr-body.md");
  await writeFile(prBody, `PR 详情含密钥 ${LEAK_GH}\n`);
  const edited = await forge.editPr(
    { cwd: dir, timeoutMs: 5000 },
    "https://github.com/o/r/pull/1",
    { title: "CYC-1 title", bodyPath: prBody },
  );
  expect(edited).toEqual({ ok: true });

  const commentBody = join(dir, "comment.md");
  await writeFile(commentBody, `评审评论含密钥 ${LEAK_SLACK}\n`);
  const commented = await forge.comment(
    { cwd: dir, timeoutMs: 5000 },
    "https://github.com/o/r/pull/1",
    commentBody,
  );
  expect(commented).toEqual({ ok: true });

  expect(redactedEvents).toEqual([["github-token"], ["slack-token"]]);
  expect(writtenBodies).toEqual([
    "（含凭据形状的内容，已省略：github-token）",
    "（含凭据形状的内容，已省略：slack-token）",
  ]);
  for (const body of writtenBodies) {
    expect(body).not.toContain(LEAK_GH);
    expect(body).not.toContain(LEAK_SLACK);
  }
});

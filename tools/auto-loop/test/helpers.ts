import { type Config, defaultConfig, type Issue } from "../src/types.ts";

export const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 1,
  number: 1,
  key: "CYC-1",
  title: "title",
  description: "",
  priority: "medium",
  createdAt: "2026-11-25T00:00:00.000Z",
  columnId: 22,
  labelIds: [11],
  ...over,
});

export const config = (over: Partial<Config> = {}): Config => ({
  ...defaultConfig({ repoRoot: "/repo", stateDir: "/state" }),
  ...over,
});

/** A work item that passes the preflight. */
export const readyDescription = `## 背景
x

## 验收标准

1. 开关可用。验证：\`bun test tools/auto-loop/test/a.test.ts\`
2. 门禁通过。验证：\`bun run check\`
`;

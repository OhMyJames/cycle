import { expect, test } from "bun:test";
import {
  isSecretKey,
  REDACTED,
  redactParams,
  redactRecord,
  redactText,
  redactTool,
} from "../src/redact.ts";

// Placeholders built from pieces, so that nothing in this file is, or looks like, a real credential.
const anthropic = `sk-ant-${"x".repeat(24)}`;
const github = `ghp_${"a".repeat(36)}`;
const aws = `AKIA${"B".repeat(16)}`;
const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;

test("a key that names a secret loses its value, however deep, and the rest stays", () => {
  const out = redactTool({
    command: "ls",
    env: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "value-1",
      nested: [{ password: "value-2", user: "me" }],
    },
    headers: { Authorization: "value-3", "X-Api-Key": "value-4", Accept: "text/plain" },
    session_token: "value-5",
    cookie: "value-6",
  });
  expect(out).toEqual({
    command: "ls",
    env: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: REDACTED,
      nested: [{ password: REDACTED, user: "me" }],
    },
    headers: { Authorization: REDACTED, "X-Api-Key": REDACTED, Accept: "text/plain" },
    session_token: REDACTED,
    cookie: REDACTED,
  });
});

test("keys that are about tokens as a count, or only look similar, are kept", () => {
  const kept = {
    inputTokens: 10,
    max_tokens: 4096,
    tokens: 3,
    keyboard: "k",
    monkey: "m",
    author: "a",
    passwordless: true,
    secretary: "s",
    token: "",
    apiKey: null,
  };
  expect(redactTool(kept)).toEqual(kept);
});

test("{name, value} pairs, which is how an env list is written", () => {
  expect(
    redactTool({
      env: [
        { name: "GITHUB_TOKEN", value: "v" },
        { name: "HOME", value: "/home/x" },
      ],
    }),
  ).toEqual({
    env: [
      { name: "GITHUB_TOKEN", value: REDACTED },
      { name: "HOME", value: "/home/x" },
    ],
  });
});

test("strings: token shapes, private keys, bearer, env assignments, flags and json pairs", () => {
  const text = [
    `a ${anthropic} b`,
    `token ${github}`,
    `id ${aws}`,
    `jwt ${jwt}`,
    "Authorization: Bearer abcdefghijklmnop1234",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----",
    "ITSAPLAN_API_KEY=plainvalue123",
    'DB_PASSWORD="two words"',
    "curl --token=abc123 --api-key def456",
    '{"password": "hunter2hunter2", "user": "me"}',
    "postgres://admin:s3cretpass@db.example/x",
    "GET /v1?token=querytoken99&page=2",
    "password=lowercase99",
  ].join("\n");
  const out = redactText(text);
  for (const gone of [
    anthropic,
    github,
    aws,
    jwt,
    "abcdefghijklmnop1234",
    "AAAA",
    "plainvalue123",
    "two words",
    "abc123",
    "def456",
    "hunter2hunter2",
    "s3cretpass",
    "querytoken99",
    "lowercase99",
  ])
    expect(out).not.toContain(gone);
  expect(out).toContain(`ITSAPLAN_API_KEY=${REDACTED}`);
  expect(out).toContain('"user": "me"');
});

test("text that is only text is untouched", () => {
  for (const text of [
    "const token = getToken();",
    "max_tokens: 4096",
    "the password field is required",
    "git checkout main && bun run check",
    "sk-short",
    '{"password": ""}',
    "Basic configuration of the server",
    "Bearer tokenization strategy",
    "const API_KEY = process.env.API_KEY;",
    "PRIMARY_KEY = 'id'",
    "if (MAX_TOKEN == 5) run()",
    "https://example.test/a:b@c",
    "token = f()",
  ])
    expect(redactText(text)).toBe(text);
});

test("what the person and the model said is not touched; tool calls and permission requests are", () => {
  const message = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: github } };
  expect(redactRecord("update", message)).toBe(message);
  const call = {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Bash",
    rawInput: { command: `curl -H "Authorization: Bearer abcdefghijklmnop1234"` },
  };
  expect(JSON.stringify(redactRecord("update", call))).not.toContain("abcdefghijklmnop1234");
  expect(redactRecord("update", call)).toMatchObject({ toolCallId: "t1", title: "Bash" });
  const request = {
    requestId: "1",
    method: "m",
    params: { subject: { type: "tool_call", toolCall: { rawInput: { password: "pw-value" } } } },
  };
  expect(JSON.stringify(redactRecord("request", request))).not.toContain("pw-value");
  // A form's schema can have a field called password: it is the form, not an answer.
  const form = { properties: { password: { type: "string" } } };
  expect(redactParams({ requestedSchema: form })).toEqual({ requestedSchema: form });
});

test("a very deep value does not hang or throw", () => {
  let deep: unknown = "x";
  for (let i = 0; i < 200; i++) deep = { a: deep };
  expect(() => redactTool(deep)).not.toThrow();
  expect(isSecretKey("Api-Key")).toBe(true);
});

test("a large string with nothing to find is cleaned in linear time", () => {
  const started = performance.now();
  for (const text of [
    "-".repeat(200_000),
    "--a".repeat(70_000),
    `${"--abc-".padEnd(80, "x")}`.repeat(3_000),
  ])
    redactText(text);
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("a background task's title, made from its command, is cleaned like a tool call's (CYCL-87)", () => {
  const task = {
    sessionUpdate: "_cycle/task_update",
    taskId: "b1",
    kind: "shell",
    title: `curl -H "Authorization: Bearer abcdefghijklmnop1234" api`,
    state: "running",
  };
  const kept = redactRecord("update", task);
  expect(JSON.stringify(kept)).not.toContain("abcdefghijklmnop1234");
  expect(kept).toMatchObject({ taskId: "b1", kind: "shell", state: "running" });
  // The goal is the person's own words, as a message is.
  const goal = { sessionUpdate: "_cycle/goal_update", goal: { condition: github } };
  expect(redactRecord("update", goal)).toBe(goal);
});

test("a scheduled call's prompt, written by the agent, is cleaned like a tool call's (CYCL-146)", () => {
  const schedule = {
    sessionUpdate: "_cycle/schedule_update",
    jobs: [
      {
        id: "c1",
        kind: "cron",
        schedule: "*/30 * * * *",
        recurring: true,
        durable: false,
        prompt: `Check the deploy with curl -H "Authorization: Bearer abcdefghijklmnop1234"`,
      },
    ],
  };
  const kept = redactRecord("update", schedule);
  expect(JSON.stringify(kept)).not.toContain("abcdefghijklmnop1234");
  expect(kept).toMatchObject({ jobs: [{ id: "c1", schedule: "*/30 * * * *", recurring: true }] });
});

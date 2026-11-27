// A real-model comparison of Codex's direct tools and mixed code mode through Cycle's gateway.
//
//   CYCLE_REAL_MODEL_TOKEN=... bun apps/daemon/scripts/codex-deepseek-ab.ts
//
// The key goes only to the local model gateway. Each arm gets a fresh project and CODEX_HOME,
// which are removed afterwards. This script needs outbound network access; it is outside
// `bun run check` because it spends real model tokens.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  catalogModels,
  type ProviderConfig,
  piModel,
  splitModelRef,
  startGateway,
} from "@cycle/model-gateway";

const apiKey = process.env.CYCLE_REAL_MODEL_TOKEN;
if (!apiKey) throw new Error("Set CYCLE_REAL_MODEL_TOKEN to the DeepSeek key for the A/B");

const provider: ProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "deepseek",
  api: null,
  baseUrl: null,
  apiKey,
  models: catalogModels("deepseek").filter((model) => model.id === "deepseek-flash"),
};
const gatewayToken = "deepseek-ab-gateway-token";
const gateway = startGateway({
  token: gatewayToken,
  resolve(ref) {
    const split = splitModelRef(ref);
    if (split?.providerId !== "deepseek" && split?.providerId !== "deepseek-direct") return null;
    const model = piModel(provider, split.modelId);
    return model ? { model, apiKey } : null;
  },
});

const prompt =
  "Use shell tools only. Read a.txt and find its KEY value. Then search below the current directory for that value. The matching line names a vault file; read it and report COUNT=<number>. Also find every .txt file below the current directory whose content contains the exact lowercase word alpha as a substring, excluding non-.txt files, and report their relative paths sorted comma-separated. Do not guess and do not modify files.";

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

async function filesUnder(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else files.push(child);
  }
  return files;
}

async function run(mode: "direct" | "code", trial: number) {
  const root = await mkdtemp(join(tmpdir(), `cycle-deepseek-${mode}-${trial}-`));
  try {
    const cwd = join(root, "project");
    const home = join(root, "codex");
    await mkdir(join(cwd, "more"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(cwd, "a.txt"), "KEY=PLUM\npurpose=fixture\nend=yes\n");
    await writeFile(join(cwd, "b.txt"), "PLUM points to vault-17\n");
    await writeFile(join(cwd, "vault-17.txt"), "COUNT=6\n");
    await writeFile(join(cwd, "c.txt"), "alpha appears here\n");
    await writeFile(join(cwd, "d.txt"), "nothing relevant\n");
    await writeFile(join(cwd, "more", "deep.txt"), "another alpha marker\n");
    await writeFile(join(cwd, "ignore.md"), "alpha in markdown\n");

    // `deepseek` builds the proposed DeepSeek catalog, including code mode. `deepseek-direct` keeps
    // the old provider shape for the comparison arm. This read-only fixture does not exercise
    // apply_patch, and its contexts stay below the compact limit, so code mode is the main runtime
    // difference; verbosity can still affect the answer.
    const providerId = mode === "code" ? "deepseek" : "deepseek-direct";
    const modelRef = `${providerId}/deepseek-flash`;
    const model = {
      id: modelRef,
      name: "DeepSeek V4.1 Flash",
      description: "DeepSeek",
      efforts: [
        { id: "low", description: "" },
        { id: "high", description: "" },
        { id: "max", description: "" },
      ],
      defaultEffort: "high",
      images: true,
      contextWindow: 1_000_000,
      provider: { id: providerId, name: "DeepSeek" },
    };
    const entry = new URL("../src/main.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, entry, "adapter", "codex"], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({
          env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
          providers: { url: gateway.url, token: gatewayToken, models: [model] },
        }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const updates: SessionUpdate[] = [];
    const waiting: (() => void)[] = [];
    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
      close() {
        child.stdin.end();
      },
    });
    const acp = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (
        params.update.sessionUpdate === "state_update" &&
        "state" in params.update &&
        params.update.state === "idle"
      ) {
        for (const resolve of waiting.splice(0)) resolve();
      }
    });

    const textAfter = (at: number) =>
      updates
        .slice(at)
        .filter(
          (update) =>
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_message",
        )
        .map((update) => {
          const content = (
            update as unknown as { content?: { text?: string } | { text?: string }[] }
          ).content;
          return Array.isArray(content)
            ? content.map((part) => part.text ?? "").join("")
            : (content?.text ?? "");
        })
        .join("");

    const started = Date.now();
    let answer = "";
    let toolCount = 0;
    try {
      await acp.connectWith(ndJsonStream(input, child.stdout), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "deepseek-ab", version: "1" },
        });
        const { sessionId } = await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/model": modelRef },
        });
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "effort",
          type: "id",
          value: "high",
        } as never);
        const at = updates.length;
        await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${mode}: turn timed out`)), 240_000);
          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        answer = textAfter(at);
        toolCount = new Set(
          updates
            .slice(at)
            .filter((update) => update.sessionUpdate === "tool_call_update")
            .map((update) => (update as { toolCallId?: string }).toolCallId)
            .filter((id): id is string => typeof id === "string"),
        ).size;
        await agent.request(methods.agent.session.close, { sessionId });
      });
    } finally {
      child.kill();
      await child.exited;
    }

    const rollouts = (await filesUnder(home)).filter((path) => path.endsWith(".jsonl")).sort();
    const rollout = rollouts.at(-1);
    if (!rollout) throw new Error(`${mode}: Codex wrote no rollout`);
    const records = (await readFile(rollout, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
    const usage = records.flatMap((record) =>
      record.type === "token_usage_record" ? [record.payload?.usage as Usage] : [],
    );
    const calls = records.flatMap((record) =>
      record.type === "response_item" &&
      (record.payload?.type === "function_call" || record.payload?.type === "custom_tool_call")
        ? [String(record.payload.name ?? "")]
        : [],
    );
    const normalized = answer.replace(/\s+/g, "");
    return {
      mode,
      trial,
      model: modelRef,
      ms: Date.now() - started,
      requests: usage.length,
      inputTokens: usage.reduce((sum, item) => sum + item.input_tokens, 0),
      cachedInputTokens: usage.reduce((sum, item) => sum + item.cached_input_tokens, 0),
      uncachedInputTokens: usage.reduce(
        (sum, item) => sum + item.input_tokens - item.cached_input_tokens,
        0,
      ),
      outputTokens: usage.reduce((sum, item) => sum + item.output_tokens, 0),
      reasoningTokens: usage.reduce((sum, item) => sum + item.reasoning_output_tokens, 0),
      tools: toolCount,
      calls: Object.fromEntries(
        [...new Set(calls)]
          .sort()
          .map((name) => [name, calls.filter((call) => call === name).length]),
      ),
      success: normalized.includes("COUNT=6") && normalized.includes("c.txt,more/deep.txt"),
      answer: answer.slice(-1200),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  const results = [];
  for (let trial = 1; trial <= 3; trial++) {
    results.push(await run("direct", trial));
    results.push(await run("code", trial));
  }
  const summary = (["direct", "code"] as const).map((mode) => {
    const runs = results.filter((result) => result.mode === mode);
    const average = (pick: (result: (typeof runs)[number]) => number) =>
      Math.round(runs.reduce((sum, result) => sum + pick(result), 0) / runs.length);
    return {
      mode,
      runs: runs.length,
      success: runs.filter((result) => result.success).length,
      averageRequests: average((result) => result.requests),
      averageTools: average((result) => result.tools),
      averageInputTokens: average((result) => result.inputTokens),
      averageUncachedInputTokens: average((result) => result.uncachedInputTokens),
      averageOutputTokens: average((result) => result.outputTokens),
      averageMs: average((result) => result.ms),
    };
  });
  console.log(JSON.stringify({ summary, results }, null, 2));
} finally {
  gateway.stop();
}

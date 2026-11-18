/**
 * What each agent offers a session, as one list (`options.list`, `options.changed`), beside the two
 * lists of before: the real `codex app-server` and the real Claude Code, each against a scripted
 * model, in one daemon.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import { type Option, optionsFromLegacy } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let providers: OpenProviders;
let root: string;
let client: WireClient;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-options-"));
  mkdirSync(join(root, "codex"));
  codexModel = startMockModel(() => ({ text: ["ok"] }));
  claude = startMockClaude(root, () => ({ text: ["ok"] }));
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        provider: providers.provider,
      }),
      [new ClaudeHarness({ env: claude.env })],
    ),
    home: join(root, "home"),
  });
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  providers?.stop();
  codexModel?.stop();
  claude?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** The options with each model's default set aside, which `models.list` keeps for the main agent. */
const unmarked = (list: Option[]) =>
  list.map((option) => ({
    ...option,
    values: option.values.map((value) => ({
      ...value,
      default: option.id === "mode" && value.default,
    })),
  }));

test("each agent's options are its old lists as one, the main agent first, and nothing is lost", async () => {
  const { agents } = await client.call("options.list", {});
  expect(agents.map((entry) => entry.agent)).toEqual(["codex", "claude"]);
  const { models } = await client.call("models.list", {});
  const { modes } = await client.call("modes.list", {});
  for (const { agent, options } of agents) {
    // `models.list` leaves the default of a new session to the main agent's models, and an option
    // keeps what its agent says: the same lists once that is set aside.
    expect(unmarked(options)).toEqual(unmarked(optionsFromLegacy(agent, modes, models)));
    const model = options.find((option) => option.id === "model");
    const mode = options.find((option) => option.id === "mode");
    // Every model, every effort of each, and every mode can be found by its id.
    const own = models.filter((each) => each.harness === agent);
    expect(model?.values.map((value) => value.id)).toEqual(own.map((each) => each.id));
    for (const each of own) {
      const value = model?.values.find((one) => one.id === each.id);
      expect(value?.under[0]?.values.map((effort) => effort.id) ?? []).toEqual(
        each.efforts.map((effort) => effort.id),
      );
    }
    expect(mode?.values.map((value) => value.id)).toEqual(
      modes.filter((each) => each.harness === agent).map((each) => each.id),
    );
    // Exactly one mode is the default, and none that never asks is.
    expect(mode?.values.filter((value) => value.default)).toHaveLength(1);
    expect(mode?.values.some((value) => value.default && value.dangerous)).toBe(false);
  }
  // The main agent's default model is the one `models.list` marks. Another agent's list says its own
  // default, which `models.list` leaves out.
  const defaults = (agent: string) =>
    agents
      .find((entry) => entry.agent === agent)
      ?.options.find((option) => option.id === "model")
      ?.values.filter((value) => value.default)
      .map((value) => value.id);
  expect(defaults("codex")).toEqual(models.filter((each) => each.isDefault).map((each) => each.id));
  expect(defaults("claude")).toHaveLength(1);
});

test("a provider of the owner's adds its models to codex's options, and every client is told", async () => {
  const seen = client.pushes.length;
  await client.call("providers.save", {
    name: "My endpoint",
    kind: "custom",
    api: "openai-responses",
    baseUrl: codexModel.url,
    apiKey: "secret-key",
    models: [
      {
        id: "mock-model",
        name: "Mock",
        reasoning: false,
        images: false,
        contextWindow: 1_000_000,
        maxTokens: 4_000,
      },
    ],
  });
  await client.until(() =>
    client.pushes
      .slice(seen)
      .some(
        (push) =>
          push.type === "options.changed" &&
          push.agent === "codex" &&
          push.options.some((option) =>
            option.values.some((value) => value.id === "my-endpoint/mock-model"),
          ),
      ),
  );
  const { agents } = await client.call("options.list", {});
  const codex = agents[0]?.options.find((option) => option.id === "model");
  expect(codex?.values.find((value) => value.id === "my-endpoint/mock-model")).toMatchObject({
    name: "Mock",
    default: false,
    provider: { id: "my-endpoint", name: "My endpoint" },
  });
  expect(client.pushes.slice(seen).some((push) => push.type === "models.changed")).toBe(true);
  // The key went in and does not come back out.
  expect(JSON.stringify(agents)).not.toContain("secret-key");
}, 30_000);

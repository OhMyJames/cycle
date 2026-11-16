import { expect, test } from "bun:test";
import {
  type SandboxSpec,
  createArgs,
  envFile,
  plainSpec,
  sandboxName,
  specVersion,
  templateTag,
} from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";

const signal = new AbortController().signal;
const app = "/Users/me/app";
const request = { command: "claude", args: [], cwd: app, env: {}, signal };

function node(change: Partial<SandboxSpec> = {}): SandboxSpec {
  return { ...plainSpec("node"), ...change };
}

test("a sandbox is made with its environment's size and variables, whose values are in a file alone", async () => {
  const spec = node({ cpus: 4, memoryGb: 8, variables: { NPM_TOKEN: "s3cret", CI: "1" } });
  expect(
    createArgs("box", app, "/home/me/.cycle/sandboxes/box/claude", spec, null, "/tmp/v").slice(
      0,
      10,
    ),
  ).toEqual([
    "--no-input",
    "create",
    "--name",
    "box",
    "--cpus",
    "4",
    "--memory",
    "8g",
    "--env-file",
    "/tmp/v",
  ]);
  expect(envFile(spec.variables)).toBe("CI=1\nNPM_TOKEN=s3cret\n");
  const { sandboxes, given, files } = fakeSbx([], [spec]);
  await sandboxes.ensure(app, { environment: "node" });
  // Not an argument, and not in the environment `sbx` itself runs with.
  expect(files).toEqual(["CI=1\nNPM_TOKEN=s3cret\n"]);
  expect(JSON.stringify(given)).not.toContain("s3cret");
  // With no variables there is no file to keep.
  const plain = fakeSbx();
  await plain.sandboxes.ensure(app, { environment: "standard" });
  expect(plain.files).toEqual([]);
});

test("the setup script runs once in a new sandbox, which is saved for the next folder's to start from", async () => {
  const spec = node({ setup: "npm ci" });
  const tag = templateTag(spec);
  const { sandboxes, did, templates } = fakeSbx([], [spec]);
  const first = await sandboxes.ensure(app, { environment: "node" });
  expect(did().slice(1)).toEqual([
    `exec -w /home/agent/workspace/app ${first} bash -lc npm ci`,
    `template save ${first} ${tag}`,
  ]);
  expect(templates).toEqual([tag]);
  // Found again, it is neither made nor set up again.
  await sandboxes.ensure(app, { environment: "node" });
  expect(did()).toHaveLength(3);
  // Another folder's sandbox starts from the saved one, with nothing to run.
  const second = await sandboxes.ensure("/Users/me/other", { environment: "node" });
  const started = did().slice(3);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatch(
    new RegExp(
      `^create --name ${second} -t ${tag} --pull never claude /tmp/cycle-sandbox/[0-9a-f]{8} ` +
        `/Users/me/other:/home/agent/workspace/other ` +
        `/home/me/.cycle/sandboxes/${second}/claude/projects/-home-agent-workspace-other:` +
        `/home/agent/.claude/projects/-home-agent-workspace-other$`,
    ),
  );
});

test("a setup script that fails leaves no sandbox, and one that cannot be saved is still used", async () => {
  const spec = node({ setup: "exit 1" });
  const failed = fakeSbx([], [spec]);
  failed.state.failing = "exec";
  expect(failed.sandboxes.ensure(app, { environment: "node" })).rejects.toThrow(
    "The sandbox's setup script failed: it broke",
  );
  await Promise.resolve();
  // What the script printed may repeat a variable's value: it is not said on.
  const leaky = fakeSbx([], [node({ setup: "exit 1", variables: { TOKEN: "it broke" } })]);
  leaky.state.failing = "exec";
  expect(leaky.sandboxes.ensure(app, { environment: "node" })).rejects.toThrow(
    "The sandbox's setup script failed: ***",
  );
  const unsaved = fakeSbx([], [spec]);
  unsaved.state.failing = "template save";
  const name = await unsaved.sandboxes.ensure(app, { environment: "node" });
  expect(unsaved.names).toEqual([name]);
  expect(unsaved.logged).toEqual(["sbx could not save the sandbox: it broke"]);
});

test("a failed setup removes what it made", async () => {
  const failed = fakeSbx([], [node({ setup: "exit 1" })]);
  failed.state.failing = "exec";
  await failed.sandboxes.ensure(app, { environment: "node" }).catch(() => {});
  expect(failed.names).toEqual([]);
  expect(failed.made).toEqual({});
});

test("a sandbox is made again once its environment changed, but not under a running session", async () => {
  const spec = node({ cpus: 2 });
  const { sandboxes, did, started, made, templates } = fakeSbx([], [spec]);
  const name = await sandboxes.ensure(app, { environment: "node" });
  expect(made[name]).toEqual({
    environment: "node",
    version: specVersion(spec),
    hosts: [],
    cwd: app,
    layout: 2,
  });
  sandboxes.start(name, request);
  spec.cpus = 4;
  spec.setup = "npm ci";
  // A session is running in it: it stays as it is.
  await sandboxes.ensure(app, { name });
  expect(did().filter((line) => line.startsWith("rm"))).toEqual([]);
  started[0]?.exit();
  // The session's own name finds its environment, and the sandbox is made again as that says now.
  await sandboxes.ensure(app, { name });
  const again = did().slice(2, 4);
  expect(again[0]).toBe(`rm --force ${name}`);
  expect(again[1]).toMatch(
    new RegExp(
      `^create --name ${name} --cpus 4 claude /tmp/cycle-sandbox/[0-9a-f]{8} ` +
        `${app}:/home/agent/workspace/app ` +
        `/home/me/.cycle/sandboxes/${name}/claude/projects/-home-agent-workspace-app:` +
        `/home/agent/.claude/projects/-home-agent-workspace-app$`,
    ),
  );
  expect(made[name]?.version).toBe(specVersion(spec));
  // A new script is a new saved sandbox, and the one of the script before it is dropped.
  const before = templateTag(spec);
  spec.setup = "npm ci && npm run build";
  await sandboxes.ensure(app, { name });
  expect(templates).toEqual([templateTag(spec)]);
  expect(templates).not.toContain(before);
});

test("a sandbox whose paths changed is not used by a session running in it", async () => {
  const { sandboxes, made, names } = fakeSbx([], [node()]);
  const name = sandboxName(app, "node");
  names.push(name);
  made[name] = { environment: "node", version: "old", hosts: [], cwd: app, layout: 1 };
  sandboxes.start(name, request);
  expect(sandboxes.ensure(app, { name })).rejects.toThrow("must be made again");
});

test("a sandbox made before its folder was kept is told it when it is found", async () => {
  const { sandboxes, made, names } = fakeSbx([], [node()]);
  const name = sandboxName(app, "node");
  names.push(name);
  made[name] = { environment: "node", version: specVersion(node()), hosts: [] };
  expect(await sandboxes.ensure(app, { environment: "node" })).toBe(name);
  expect(made[name]?.cwd).toBe(app);
});

test("hosts are opened and closed on the sandbox as it is, with no making again", async () => {
  const spec = node({ hosts: ["api.example.com", "*.example.org"] });
  const { sandboxes, did, made } = fakeSbx([], [spec]);
  const name = await sandboxes.ensure(app, { environment: "node" });
  expect(did().at(-1)).toBe(`policy allow network --sandbox ${name} api.example.com,*.example.org`);
  spec.hosts = ["*.example.org", "registry.example.net"];
  await sandboxes.ensure(app, { environment: "node" });
  expect(did().slice(-2)).toEqual([
    `policy rm network --sandbox ${name} --force --resource api.example.com`,
    `policy allow network --sandbox ${name} registry.example.net`,
  ]);
  expect(made[name]?.hosts).toEqual(spec.hosts);
  expect(did().filter((line) => line.startsWith("create"))).toHaveLength(1);
  // Nothing changed, nothing asked.
  const asked = did().length;
  await sandboxes.ensure(app, { environment: "node" });
  expect(did()).toHaveLength(asked);
});

test("an environment that is gone takes its sandboxes and saved sandbox with it, but for one in use", async () => {
  const spec = node({ setup: "npm ci" });
  const { sandboxes, names, templates, made, started } = fakeSbx([], [spec, plainSpec("standard")]);
  const idle = await sandboxes.ensure(app, { environment: "node" });
  const busy = await sandboxes.ensure("/Users/me/other", { environment: "node" });
  const kept = await sandboxes.ensure(app, { environment: "standard" });
  sandboxes.start(busy, request);
  // One that never started is not running.
  sandboxes.start(idle, request);
  started.at(-1)?.fail();
  await sandboxes.forget("node");
  expect(names.toSorted()).toEqual([busy, kept].toSorted());
  expect(Object.keys(made).toSorted()).toEqual([busy, kept].toSorted());
  expect(templates).toEqual([]);
  expect(names).not.toContain(idle);
  // A session of a sandbox whose record is gone still finds it by name.
  expect(sandboxName(app, "node")).toBe(idle);
});

test("a secret goes to sbx over its input, and is in no argument and no error", async () => {
  const { sandboxes, given, state } = fakeSbx();
  expect((await sandboxes.secrets()).find((one) => one.service === "anthropic")?.set).toBe(false);
  await sandboxes.setSecret("anthropic", " sk-ant-123 \n");
  const set = given.find((one) => one.args[1] === "set");
  expect(set).toMatchObject({
    args: ["secret", "set", "anthropic", "--force"],
    input: "sk-ant-123\n",
  });
  expect((await sandboxes.secrets()).find((one) => one.service === "anthropic")?.set).toBe(true);
  expect(sandboxes.setSecret("--registry", "x")).rejects.toThrow("not one sbx keeps");
  expect(sandboxes.setSecret("github", "two words")).rejects.toThrow("no spaces");
  state.fail = "could not store sk-ant-123";
  expect(sandboxes.setSecret("github", "sk-ant-123")).rejects.toThrow(
    /^sbx could not store the secret\.$/,
  );
});

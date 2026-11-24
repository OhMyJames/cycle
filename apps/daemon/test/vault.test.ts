// The vault (docs/protocol.md §6 "环境"): the keys of secrets.env are listed, set and removed; a value never comes back.
import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Daemon } from "../src/index.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const connect = async () => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const call = <T>(method: string, params: object) =>
    c.agent.request(method as never, params as never) as Promise<T>;
  return { c, call };
};

test("a key is set, replaced and removed in secrets.env, and the person's own lines stay", async () => {
  await writeFile(join(dir, "secrets.env"), "# mine\nA=1\nexport B='two'\nA=again\n", {
    mode: 0o644,
  });
  const { c, call } = await connect();
  expect((c.init._meta as Record<string, { vault?: boolean }>)["cycle/capabilities"]?.vault).toBe(
    true,
  );
  expect(await call("_cycle/vault/list", {})).toEqual({ items: [{ key: "A" }, { key: "B" }] });
  await call("_cycle/vault/set", { key: "A", value: "it's new" });
  await call("_cycle/vault/set", { key: "C", value: " spaced " });
  const text = await readFile(join(dir, "secrets.env"), "utf8");
  // Replaced where it was, its repeat dropped, the comment and B untouched, C added.
  expect(text).toBe("# mine\nA='it's new'\nexport B='two'\nC=' spaced '\n");
  expect((await stat(join(dir, "secrets.env"))).mode & 0o777).toBe(0o600);
  const { parseSecretsFile } = await import("@cycle/protocol");
  expect(parseSecretsFile(text)).toEqual({ A: "it's new", B: "two", C: " spaced " });
  await call("_cycle/vault/remove", { key: "B" });
  await call("_cycle/vault/remove", { key: "NOT_THERE" });
  expect(await call("_cycle/vault/list", {})).toEqual({ items: [{ key: "A" }, { key: "C" }] });
  expect(JSON.stringify(await call("_cycle/vault/list", {}))).not.toContain("spaced");
});

test("a key a shell cannot take, or a value of more than one line, is refused", async () => {
  const { call } = await connect();
  await expect(call("_cycle/vault/set", { key: "NOT-OK", value: "x" })).rejects.toMatchObject({
    code: -32602,
  });
  await expect(call("_cycle/vault/set", { key: "OK", value: "a\nb" })).rejects.toMatchObject({
    code: -32602,
  });
});

test("a key set in the vault is the value an environment's secret gets", async () => {
  const { call } = await connect();
  await call("_cycle/vault/set", { key: "WORK_GH", value: "gh-work-1" });
  const { shellVariablesOf } = await import("../src/environment.ts");
  const { variables } = await shellVariablesOf(
    {
      id: "e",
      name: "E",
      variables: [],
      secrets: [{ name: "GH_TOKEN", from: "WORK_GH" }],
      actions: [],
    },
    dir,
  );
  expect(variables).toEqual({ GH_TOKEN: "gh-work-1" });
});

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "../src/agent.ts";

const OWN = {
  id: "acme/fast",
  name: "Fast",
  description: "Acme",
  efforts: [
    { id: "low", description: "" },
    { id: "max", description: "" },
  ],
  defaultEffort: "low",
  images: false,
  contextWindow: 1_000_000,
  provider: { id: "acme", name: "Acme" },
};

test("a provider thread gets one private catalog, and it is removed when the session closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-provider-catalog-"));
  const executable = join(dir, "fake"),
    starts = join(dir, "starts.json"),
    calls = join(dir, "calls.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync, writeFileSync} from "node:fs";
import {createInterface} from "node:readline";
if (process.argv.includes("debug")) {
  console.log(JSON.stringify({models:[{slug:"gpt-5.6-sol",model_messages:{instructions_template:"bundled"}}]}));
  process.exit(0);
}
const send=m=>console.log(JSON.stringify(m));
for await(const line of createInterface({input:process.stdin})){
  const {method,id,params}=JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, method+"\\n");
  if(method==="initialize")send({id,result:{userAgent:"codex-cli 0.171.0"}});
  if(method==="thread/start"){writeFileSync(${JSON.stringify(starts)}, JSON.stringify(params));send({id,result:{thread:{id:"s"}}});}
  if(method==="skills/list")send({id,result:{data:[]}});
  if(method==="account/rateLimits/read")send({id,result:{rateLimits:null}});
  if(method==="thread/close")send({id,result:{}});
}
`,
    { mode: 0o700 },
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
    providers: {
      url: "http://127.0.0.1:4000/v1",
      token: "gw-token",
      models: [OWN],
    },
  });
  try {
    await client().connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, {
        cwd: dir,
        _meta: { "cycle/model": OWN.id },
      });
      const params = JSON.parse(await readFile(starts, "utf8")) as {
        config: { model_catalog_json: string; model_context_window?: number };
      };
      expect(params.config.model_context_window).toBeUndefined();
      expect(params.config.model_catalog_json).toStartWith(join(tmpdir(), "cycle-codex-catalog-"));
      const catalog = await readFile(params.config.model_catalog_json, "utf8");
      expect(JSON.parse(catalog)).toMatchObject({
        models: [
          {
            slug: OWN.id,
            context_window: 1_000_000,
            max_context_window: 1_000_000,
            effective_context_window_percent: 95,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
          },
        ],
      });
      expect(catalog).not.toContain("gw-token");
      expect((await readFile(calls, "utf8")).split("\n")).not.toContain("model/list");

      await agent.request(methods.agent.session.close, { sessionId });
      expect(existsSync(dirname(params.config.model_catalog_json))).toBe(false);
    });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Codex-owned session gets no provider catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-no-provider-catalog-"));
  const executable = join(dir, "fake"),
    starts = join(dir, "starts.json");
  await writeFile(
    executable,
    `#!${process.execPath}
import {writeFileSync} from "node:fs";
import {createInterface} from "node:readline";
const send=m=>console.log(JSON.stringify(m));
for await(const line of createInterface({input:process.stdin})){
  const {method,id,params}=JSON.parse(line);
  if(method==="initialize")send({id,result:{userAgent:"codex-cli 0.171.0"}});
  if(method==="model/list")send({id,result:{data:[],nextCursor:null}});
  if(method==="thread/start"){writeFileSync(${JSON.stringify(starts)}, JSON.stringify(params));send({id,result:{thread:{id:"s"}}});}
  if(method==="skills/list")send({id,result:{data:[]}});
  if(method==="account/rateLimits/read")send({id,result:{rateLimits:null}});
}
`,
    { mode: 0o700 },
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  try {
    await client().connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      await agent.request(methods.agent.session.new, { cwd: dir });
      const params = JSON.parse(await readFile(starts, "utf8")) as {
        config?: { model_catalog_json?: string };
      };
      expect(params.config?.model_catalog_json).toBeUndefined();
    });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "../src/agent.ts";

test("a crashed server fails its open tool and ends the accepted turn exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-crash-"));
  const executable = join(dir, "fake");
  await writeFile(
    executable,
    `#!${process.execPath}
 import {createInterface} from "node:readline";
 const send=m=>console.log(JSON.stringify(m));
 for await(const line of createInterface({input:process.stdin})){
   const {method,id}=JSON.parse(line);
   if(method==="initialize")send({id,result:{userAgent:"codex-cli 0.171.0"}});
   if(method==="model/list")send({id,result:{data:[],nextCursor:null}});
   if(method==="thread/start")send({id,result:{thread:{id:"s"}}});
   if(method==="turn/start"){
     send({id,result:{turn:{id:"t"}}});
     send({method:"item/started",params:{threadId:"s",turnId:"t",item:{id:"tool",type:"commandExecution",command:"pwd",status:"inProgress"}}});
     process.exit(7);
   }
 }
`,
    { mode: 0o700 },
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: SessionUpdate[] = [];
  const idle = Promise.withResolvers<void>();
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
    if ("state" in params.update && params.update.state === "idle") idle.resolve();
  });
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd: dir });
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });
      await idle.promise;
      expect(updates.filter((u) => u.sessionUpdate === "state_update")).toMatchObject([
        { state: "running" },
        { state: "idle", stopReason: "error" },
      ]);
      expect(updates.filter((u) => u.sessionUpdate === "tool_call_update")).toMatchObject([
        { status: "in_progress" },
        { status: "failed" },
      ]);
    });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 3000);

test("embedded text reaches Codex, a turn refused for want of a login says how to sign in, and a later title is told", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-auth-"));
  const executable = join(dir, "fake");
  const inputs = join(dir, "inputs.json");
  await writeFile(
    executable,
    `#!${process.execPath}
 import {createInterface} from "node:readline";
 import {writeFileSync} from "node:fs";
 const send=m=>console.log(JSON.stringify(m));
 for await(const line of createInterface({input:process.stdin})){
   const {method,id,params}=JSON.parse(line);
   if(method==="initialize")send({id,result:{userAgent:"codex-cli 0.171.0"}});
   if(method==="model/list")send({id,result:{data:[],nextCursor:null}});
   if(method==="thread/start")send({id,result:{thread:{id:"s"}}});
   if(method==="turn/start"){
     writeFileSync(${JSON.stringify(inputs)}, JSON.stringify(params.input));
     send({id,result:{turn:{id:"t"}}});
     send({method:"turn/completed",params:{threadId:"s",turn:{id:"t",status:"failed",error:{message:"401",codexErrorInfo:"unauthorized",additionalDetails:null,misalignment:null}}}});
     send({method:"thread/name/updated",params:{threadId:"s",threadName:"Named later"}});
   }
 }
`,
    { mode: 0o700 },
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: SessionUpdate[] = [];
  const titled = Promise.withResolvers<void>();
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
    if (params.update.sessionUpdate === "session_info_update") titled.resolve();
  });
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd: dir });
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "look" },
          { type: "resource", resource: { uri: "file:///a.txt", text: "inside" } },
        ],
      });
      await titled.promise;
      expect(JSON.parse(await Bun.file(inputs).text())).toMatchObject([
        { type: "text", text: "look" },
        { type: "text", text: "file:///a.txt\ninside" },
      ]);
      expect(updates.find((u) => "state" in u && u.state === "idle")).toMatchObject({
        stopReason: "error",
        error: { message: expect.stringContaining("cycle login codex") },
      });
      expect(updates.at(-1)).toMatchObject({ title: "Named later" });
    });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 3000);

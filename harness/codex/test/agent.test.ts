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

test("every turn names its model and effort, plan mode is entered and left, and sub-agents end and ask in their own thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-turns-"));
  const executable = join(dir, "fake");
  const starts = join(dir, "starts.jsonl");
  const answers = join(dir, "answers.jsonl");
  const model = (name: string, efforts: string[], isDefault: boolean) => ({
    id: name,
    model: name,
    displayName: name,
    description: name,
    hidden: false,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: e })),
    defaultReasoningEffort: efforts[0],
    isDefault,
  });
  const catalog = [model("base", ["medium"], true), model("other", ["low", "high"], false)];
  await writeFile(
    executable,
    `#!${process.execPath}
 import {createInterface} from "node:readline";
 import {appendFileSync} from "node:fs";
 const send=m=>console.log(JSON.stringify(m));
 let n=0;
 for await(const line of createInterface({input:process.stdin})){
   const msg=JSON.parse(line);
   const {method,id,params}=msg;
   if(method===undefined){appendFileSync(${JSON.stringify(answers)}, JSON.stringify(msg.result)+"\\n");send({method:"turn/completed",params:{threadId:"kid",turn:{id:"k1",status:"completed",error:null}}});continue;}
   if(method==="initialize")send({id,result:{userAgent:"codex-cli 0.171.0"}});
   if(method==="model/list")send({id,result:{data:${JSON.stringify(catalog)},nextCursor:null}});
   if(method==="thread/start")send({id,result:{thread:{id:"s"},model:"base",reasoningEffort:"medium"}});
   if(method==="turn/start"){
     appendFileSync(${JSON.stringify(starts)}, JSON.stringify(params)+"\\n");
     const t="t"+(++n);
     send({id,result:{turn:{id:t}}});
     if(n===1){
       send({method:"turn/plan/updated",params:{threadId:"s",turnId:t,explanation:null,plan:[{step:"look",status:"inProgress"}]}});
       send({method:"item/completed",params:{threadId:"s",turnId:t,item:{type:"collabAgentToolCall",id:"c",tool:"spawnAgent",status:"completed",senderThreadId:"s",receiverThreadIds:["kid"],prompt:null,model:null,reasoningEffort:null,agentsStates:{kid:{status:"running",message:null}}}}});
       send({id:"ask",method:"item/commandExecution/requestApproval",params:{threadId:"kid",turnId:"k1",itemId:"x",command:"ls",reason:null}});
       send({method:"turn/completed",params:{threadId:"s",turn:{id:t,status:"completed",error:null}}});
     } else send({method:"turn/completed",params:{threadId:"s",turn:{id:t,status:"completed",error:null}}});
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
  const asked: unknown[] = [];
  let ended = 0;
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push({ ...params.update, _in: params.sessionId } as SessionUpdate);
      if (
        "state" in params.update &&
        params.update.state === "idle" &&
        "stopReason" in params.update
      )
        ended += 1;
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      asked.push(params.sessionId);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
  };
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd: dir });
      const set = (configId: string, value: string) =>
        agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          type: "id",
          value,
        } as never);
      const prompt = async () => {
        const before = ended;
        await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        await until(() => ended > before);
      };
      await set("mode", "plan");
      await prompt();
      await until(() => asked.length === 1);
      await set("mode", "default");
      await set("model", "other");
      await set("effort", "high");
      await prompt();
      await set("model", "default");
      await prompt();
      const sent = (await Bun.file(starts).text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(sent[0]).toMatchObject({
        model: "base",
        effort: "medium",
        collaborationMode: {
          mode: "plan",
          settings: { model: "base", reasoning_effort: "medium", developer_instructions: null },
        },
      });
      expect(sent[1]).toMatchObject({
        model: "other",
        effort: "high",
        collaborationMode: { mode: "default" },
      });
      // Back to Default is said, not left out: Codex keeps a turn's choice for the turns after it.
      expect(sent[2]).toMatchObject({ model: "base", effort: "medium" });
      expect(sent[2].collaborationMode).toBeUndefined();
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "plan_update",
          plan: expect.objectContaining({
            entries: [expect.objectContaining({ status: "in_progress" })],
          }),
        }),
      );
      // The spawn's call is done but the agent runs; it ends with its own turn, told in the parent's session.
      const kid = updates.filter((u) => u.sessionUpdate === "subagent_update");
      expect(
        kid.map((u) => [
          (u as { _in?: string })._in,
          (u as { state?: { state?: string } }).state?.state,
        ]),
      ).toEqual([
        [sessionId, "running"],
        [sessionId, "idle"],
      ]);
      expect(asked).toEqual(["kid"]);
      const answered = Bun.file(answers);
      await until(() => answered.size > 0);
      expect((await answered.text()).trim()).toBe(JSON.stringify({ decision: "accept" }));
    });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

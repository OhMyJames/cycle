import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { createAdapter } from "../src/agent.ts";
import { elicitationAnswer, questionAnswers, questionForm } from "../src/ask.ts";
import { planWindowsOf } from "../src/plan-usage.ts";

/** What the adapter sent the fake app-server: read back from its log, in the shapes these tests look at. */
type Sent = {
  method?: string;
  id?: unknown;
  params: {
    [name: string]: unknown;
    config?: { mcp_servers?: Record<string, unknown>; [name: string]: unknown };
  };
  result?: unknown;
};

/** A form the client was asked to fill. */
type Form = { message: string; requestedSchema: { properties: Record<string, unknown> } };

/**
 * A fake app-server: answers the handshake, records every message it gets in `log`, and runs `script` (the body of a
 * function of `(method, id, params, send)`) for the rest.
 */
async function fake(dir: string, script: string) {
  const executable = join(dir, "fake");
  const log = join(dir, "log.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}
 import {createInterface} from "node:readline";
 import {appendFileSync} from "node:fs";
 const send=m=>console.log(JSON.stringify(m));
 const handle=(method,id,params)=>{${script}};
 for await(const line of createInterface({input:process.stdin})){
   const msg=JSON.parse(line);
   appendFileSync(${JSON.stringify(log)}, line+"\\n");
   const {method,id,params}=msg;
   if(method===undefined)continue;
   if(method==="initialize"){send({id,result:{userAgent:"codex-cli 0.171.0"}});continue;}
   if(method==="model/list"){send({id,result:{data:[],nextCursor:null}});continue;}
   if(method==="thread/start"){send({id,result:{thread:{id:"s"},model:"m",reasoningEffort:null}});continue;}
   if(handle(method,id,params)!==true&&id!==undefined)send({id,error:{code:-32601,message:"no"}});
 }
`,
    { mode: 0o700 },
  );
  const messages = async () =>
    (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Sent);
  return { executable, messages };
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++) await Bun.sleep(10);
  expect(await check()).toBe(true);
};

test("a sub-agent as the pinned Codex tells it: announced, its words in its own session, ended, stopped alone, and a refusal is a decline even when Codex does not list it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-sub-"));
  const { executable, messages } = await fake(
    dir,
    `
    const item=(threadId,turnId,item,done)=>send({method:done?"item/completed":"item/started",params:{threadId,turnId,item}});
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      const spawn={type:"subAgentActivity",id:"call_1",kind:"started",agentThreadId:"kid",agentPath:"/root/pong_agent",model:"m",reasoningEffort:"low",startedAtMs:1,completedAtMs:null};
      item("s","t",spawn,false);
      item("s","t",{...spawn,completedAtMs:1},true);
      send({method:"turn/started",params:{threadId:"kid",turn:{id:"k1"}}});
      item("kid","k1",{type:"agentMessage",id:"m1",text:"pong",phase:null,memoryCitation:null},true);
      send({id:"ask",method:"item/commandExecution/requestApproval",params:{threadId:"kid",turnId:"k1",itemId:"x",command:"touch ../a",reason:null,availableDecisions:["accept","cancel"]}});
      return true;
    }
    if(method==="turn/interrupt"){
      send({id,result:{}});
      send({method:"turn/completed",params:{threadId:params.threadId,turn:{id:params.turnId,status:"interrupted",error:null}}});
      if(params.threadId==="kid")send({method:"turn/completed",params:{threadId:"s",turn:{id:"t",status:"completed",error:null}}});
      return true;
    }`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: (SessionUpdate & { _in: string })[] = [];
  const asked: string[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push({ ...params.update, _in: params.sessionId } as never);
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      asked.push(params.sessionId);
      return { outcome: { outcome: "selected", optionId: "deny" } };
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
        prompt: [{ type: "text", text: "go" }],
      });
      await until(async () => (await messages()).some((m) => m.id === "ask" && m.result));
      expect(asked).toEqual(["kid"]);
      expect((await messages()).find((m) => m.id === "ask")?.result).toEqual({
        decision: "decline",
      });
      // Stopping the sub-agent interrupts its own turn, not the parent's.
      await agent.notify(methods.agent.session.cancel, { sessionId: "kid" });
      await until(() =>
        updates.some((u) => u._in === sessionId && "state" in u && u.state === "idle"),
      );
      const interrupts = (await messages()).filter((m) => m.method === "turn/interrupt");
      expect(interrupts.map((m) => m.params)).toEqual([{ threadId: "kid", turnId: "k1" }]);
    });
    const subs = updates.filter((u) => u.sessionUpdate === "subagent_update") as unknown as {
      _in: string;
      sessionId: string;
      title?: string;
      capabilities?: unknown;
      state?: { state: string; stopReason?: string };
      _meta?: Record<string, unknown>;
    }[];
    expect(subs[0]).toMatchObject({
      _in: "s",
      sessionId: "kid",
      title: "pong_agent",
      capabilities: { cancel: {} },
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "call_1" } },
    });
    expect(subs.at(-1)).toMatchObject({ state: { state: "idle", stopReason: "cancelled" } });
    // The spawn is a call of the parent's; the sub-agent's words are in its own session.
    expect(updates).toContainEqual(
      expect.objectContaining({
        _in: "s",
        toolCallId: "call_1",
        name: "spawn_agent",
        title: "pong_agent",
      }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ _in: "kid", sessionUpdate: "agent_message", messageId: "m1" }),
    );
    expect(
      updates.filter((u) => u._in === "s" && "state" in u && u.state === "idle"),
    ).toMatchObject([{ stopReason: "end_turn" }]);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("Codex's question and an MCP server's form are asked as forms, and nobody to ask is said as Codex expects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-ask-"));
  const { executable, messages } = await fake(
    dir,
    `
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      send({id:"q",method:"item/tool/requestUserInput",params:{threadId:"s",turnId:"t",itemId:"i",isBlocking:true,autoResolutionMs:null,questions:[{id:"color",header:"Color",question:"Which color?",isOther:true,isSecret:false,options:[{label:"Red",description:"r"},{label:"Blue",description:"b"}]}]}});
      send({id:"form",method:"mcpServer/elicitation/request",params:{threadId:"s",turnId:"t",serverName:"x",environmentId:null,mode:"form",_meta:null,message:"Name?",requestedSchema:{type:"object",properties:{name:{type:"string"}}}}});
      send({id:"url",method:"mcpServer/elicitation/request",params:{threadId:"s",turnId:"t",serverName:"x",environmentId:null,mode:"url",_meta:null,message:"Sign in",url:"https://example.com",elicitationId:"e"}});
      return true;
    }`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const forms: Form[] = [];
  const app = client().onRequest(methods.client.elicitation.create, ({ params }) => {
    const form = params as unknown as Form;
    forms.push(form);
    return (
      form.message === "Name?"
        ? { action: "accept", content: { name: "Ada" } }
        : { action: "accept", content: { q0: "Blue", q0_other: "" } }
    ) as never;
  });
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
        capabilities: { elicitation: { form: {} } },
      } as never);
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd: dir });
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await until(async () => (await messages()).filter((m) => m.result).length === 3);
    });
    const answers = Object.fromEntries(
      (await messages()).filter((m) => m.result).map((m) => [m.id, m.result]),
    );
    expect(answers.q).toEqual({ answers: { color: { answers: ["Blue"] } } });
    expect(answers.form).toEqual({ action: "accept", content: { name: "Ada" }, _meta: null });
    // A web page to open is not a form: declined without asking.
    expect(answers.url).toEqual({ action: "decline", content: null, _meta: null });
    expect(forms.map((f) => f.message).sort()).toEqual(["Name?", "Which color?"]);
    expect(
      Object.keys(
        forms.find((f) => f.message === "Which color?")?.requestedSchema.properties ?? {},
      ),
    ).toEqual(["q0", "q0_other"]);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("the account's limits are told when they change, and Codex's skills are commands that run the skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-usage-"));
  const limits = (used: number) => ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 2000000000 },
    secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1900000000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
  });
  const { executable, messages } = await fake(
    dir,
    `
    if(method==="account/rateLimits/read"){send({id,result:{rateLimits:${JSON.stringify(limits(38))}}});return true;}
    if(method==="skills/list"){send({id,result:{data:[{cwd:params.cwds[0],errors:[],skills:[
      {name:"review-pr",description:"Long",shortDescription:"Review a PR",path:"/skills/review-pr/SKILL.md",scope:"user",enabled:true,pluginId:null},
      {name:"off",description:"Off",path:"/skills/off/SKILL.md",scope:"user",enabled:false,pluginId:null}]}]}});return true;}
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      send({method:"account/rateLimits/updated",params:{rateLimits:${JSON.stringify(limits(38))}}});
      send({method:"account/rateLimits/updated",params:{rateLimits:${JSON.stringify(limits(39))}}});
      send({method:"turn/completed",params:{threadId:"s",turn:{id:"t",status:"completed",error:null}}});
      return true;
    }`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: SessionUpdate[] = [];
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
  });
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
      });
      const opened = await agent.request(methods.agent.session.new, { cwd: dir });
      expect(
        (opened as { availableCommands?: { name: string }[] }).availableCommands,
      ).toMatchObject([{ name: "compact" }]);
      await until(() => updates.some((u) => u.sessionUpdate === "available_commands_update"));
      await agent.request(methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "/review-pr 12" }],
      });
      await until(() => updates.some((u) => "state" in u && u.state === "idle"));
    });
    expect(updates.find((u) => u.sessionUpdate === "available_commands_update")).toMatchObject({
      availableCommands: [{ name: "compact" }, { name: "review-pr", description: "Review a PR" }],
    });
    const usage = updates.filter((u) => (u.sessionUpdate as string) === "_cycle/plan_usage");
    expect(
      usage.map(
        (u) => (u as unknown as { windows: { utilization: number }[] }).windows[0]?.utilization,
      ),
    ).toEqual([0.38, 0.39]);
    expect(usage[0]).toMatchObject({
      windows: [
        { kind: "seven_day", resetsAt: 2000000000000, status: "allowed" },
        { kind: "five_hour", utilization: 0.05 },
      ],
    });
    const start = (await messages()).find((m) => m.method === "turn/start");
    expect(start?.params.input).toEqual([
      { type: "skill", name: "review-pr", path: "/skills/review-pr/SKILL.md" },
      { type: "text", text: "$review-pr 12", text_elements: [] },
    ]);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("forms and limits translate in and out", () => {
  const params = {
    threadId: "s",
    turnId: "t",
    itemId: "i",
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      { id: "a", header: "", question: "Free?", isOther: false, isSecret: true, options: null },
      {
        id: "b",
        header: "Pick",
        question: "Which?",
        isOther: false,
        isSecret: false,
        options: [{ label: "X", description: "" }],
      },
    ],
  };
  // A question without options is a free answer; one that offers no "other" has none.
  expect(Object.keys(questionForm(params).requestedSchema.properties as object)).toEqual([
    "q0_other",
    "q1",
  ]);
  expect(
    questionAnswers(params, { action: "accept", content: { q0_other: " mine ", q1: "X" } }),
  ).toEqual({ answers: { a: { answers: ["mine"] }, b: { answers: ["X"] } } });
  expect(questionAnswers(params, "unavailable")).toEqual({ answers: {} });
  expect(questionAnswers(params, { action: "decline" })).toEqual({ answers: {} });
  expect(elicitationAnswer("aborted")).toMatchObject({ action: "cancel" });
  expect(elicitationAnswer("unavailable")).toMatchObject({ action: "decline" });
  expect(
    planWindowsOf({
      limitId: "gpt-x",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    }),
  ).toEqual([]);
  expect(
    planWindowsOf({
      limitId: null,
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 2 },
      secondary: { usedPercent: 1, windowDurationMins: null, resetsAt: 2 },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    }),
  ).toEqual([{ kind: "window_60m", utilization: 1, resetsAt: 2000, status: "rejected" }]);
});

test("with no client that can show a form, the daemon's answer says so and Codex is told nobody answered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-noclient-"));
  const { executable, messages } = await fake(
    dir,
    `
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      send({id:"q",method:"item/tool/requestUserInput",params:{threadId:"s",turnId:"t",itemId:"i",isBlocking:true,autoResolutionMs:null,questions:[{id:"c",header:"C",question:"Which?",isOther:true,isSecret:false,options:null}]}});
      send({id:"form",method:"mcpServer/elicitation/request",params:{threadId:"s",turnId:"t",serverName:"x",environmentId:null,mode:"form",_meta:null,message:"Name?",requestedSchema:{type:"object",properties:{}}}});
      return true;
    }`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const app = client().onRequest(
    methods.client.elicitation.create,
    () => ({ action: "cancel", _meta: { "cycle/noClient": true } }) as never,
  );
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
        capabilities: { elicitation: { form: {} } },
      } as never);
      const { sessionId } = await agent.request(methods.agent.session.new, { cwd: dir });
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await until(async () => (await messages()).filter((m) => m.result).length === 2);
    });
    const answers = Object.fromEntries(
      (await messages()).filter((m) => m.result).map((m) => [m.id, m.result]),
    );
    expect(answers.q).toEqual({ answers: {} });
    expect(answers.form).toMatchObject({ action: "decline" });
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("a command that fails because the sandbox cannot start says so once, with what to do", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-bwrap-"));
  const { executable } = await fake(
    dir,
    `
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      for(const n of [1,2])send({method:"item/completed",params:{threadId:"s",turnId:"t",item:{type:"commandExecution",id:"c"+n,command:"ls",cwd:"/",processId:null,source:"agent",status:"failed",commandActions:[],aggregatedOutput:"bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",exitCode:1,durationMs:1}}});
      send({method:"turn/completed",params:{threadId:"s",turn:{id:"t",status:"completed",error:null}}});
      return true;
    }`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: SessionUpdate[] = [];
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
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
        prompt: [{ type: "text", text: "go" }],
      });
      await until(() => updates.some((u) => "state" in u && u.state === "idle"));
    });
    const notices = updates.filter((u) => u.sessionUpdate === "notice");
    expect(notices).toMatchObject([
      { severity: "warning", title: expect.stringContaining("sandbox cannot start") },
    ]);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("names that come out the same stay apart, a sub-agent ends on its activity alone, and stopping it withdraws its question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-edges-"));
  const { executable, messages } = await fake(
    dir,
    `
    const act=(id,kind,kid)=>send({method:"item/started",params:{threadId:"s",turnId:"t",item:{type:"subAgentActivity",id,kind,agentThreadId:kid,agentPath:"/root/"+kid,model:null,reasoningEffort:null,startedAtMs:1,completedAtMs:null}}});
    if(method==="turn/start"){
      send({id,result:{turn:{id:"t"}}});
      act("a1","started","quick");
      act("a2","completed","quick");
      act("b1","started","asker");
      send({method:"turn/started",params:{threadId:"asker",turn:{id:"k1"}}});
      send({id:"q",method:"item/tool/requestUserInput",params:{threadId:"asker",turnId:"k1",itemId:"i",isBlocking:true,autoResolutionMs:null,questions:[{id:"c",header:"C",question:"Which?",isOther:true,isSecret:false,options:null}]}});
      return true;
    }
    if(method==="turn/interrupt"){send({id,result:{}});return true;}`,
  );
  const adapter = createAdapter({
    env: { HOME: dir, CODEX_HOME: dir },
    codexExecutable: executable,
  });
  const updates: (SessionUpdate & { _in: string })[] = [];
  let asked = false;
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push({ ...params.update, _in: params.sessionId } as never);
    })
    .onRequest(methods.client.elicitation.create, async () => {
      asked = true;
      // Nobody answers: only the sub-agent's stop ends it.
      return await new Promise<never>(() => {});
    });
  try {
    await app.connectWith(adapter.app, async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "test", version: "1" },
        capabilities: { elicitation: { form: {} } },
      } as never);
      const server = (name: string) => ({
        type: "http" as const,
        name,
        url: "http://127.0.0.1:9/",
        headers: [],
      });
      const { sessionId } = await agent.request(methods.agent.session.new, {
        cwd: dir,
        mcpServers: [server("Linear (work)"), server("Linear [work]"), server("Linear_work_")],
      } as never);
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await until(() => asked);
      await agent.notify(methods.agent.session.cancel, { sessionId: "asker" });
      await until(async () => (await messages()).some((m) => m.id === "q" && m.result));
    });
    const start = (await messages()).find((m) => m.method === "thread/start");
    expect(Object.keys(start?.params.config?.mcp_servers ?? {})).toEqual([
      "Linear_work_",
      "Linear_work__2",
      "Linear_work__3",
    ]);
    const quick = updates.filter(
      (u) =>
        u.sessionUpdate === "subagent_update" &&
        (u as { sessionId?: string }).sessionId === "quick",
    );
    expect(quick.map((u) => (u as { state?: { state: string } }).state?.state)).toEqual([
      "running",
      "idle",
    ]);
    expect((await messages()).find((m) => m.id === "q")?.result).toEqual({ answers: {} });
    expect(
      (await messages()).filter((m) => m.method === "turn/interrupt").map((m) => m.params),
    ).toEqual([{ threadId: "asker", turnId: "k1" }]);
  } finally {
    adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("the session's variables go to Codex's commands through the thread's config, and only when there are some", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-codex-env-"));
  const { executable, messages } = await fake(dir, "");
  const open = async (sessionEnv?: Record<string, string>) => {
    const adapter = createAdapter({
      env: { HOME: dir, CODEX_HOME: dir },
      ...(sessionEnv !== undefined ? { sessionEnv } : {}),
      codexExecutable: executable,
    });
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: dir });
      });
    } finally {
      adapter.close();
    }
  };
  try {
    await open({ DATABASE_URL: "postgres://db", MY_API_KEY: "k" });
    await open();
    const starts = (await messages()).filter((m) => m.method === "thread/start");
    // A key per variable, merged into the person's own policy rather than replacing it.
    expect(starts[0]?.params.config).toEqual({
      "shell_environment_policy.set.DATABASE_URL": "postgres://db",
      "shell_environment_policy.set.MY_API_KEY": "k",
    });
    expect(starts[1]?.params).not.toHaveProperty("config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A second agent for tests: a harness as small as one can be, whose adapter is the fake agent on stdin and stdout.
// It is what a new harness has to give (src/harness.ts) and nothing more. Run as a program, it is a `cycle` that has
// only this agent, which is what the daemon starts for `adapter echo`.
import { type AgentApp, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { runCli } from "../../src/cli.ts";
import type { Harness } from "../../src/harness.ts";
import { processAgent } from "../../src/process-agent.ts";
import { fakeAgent } from "../fake-agent.ts";

type EchoConfig = { greeting: string };

const runAdapter = async (): Promise<void> => {
  // As the Claude adapter is: everything it needs is in CYCLE_ADAPTER_CONFIG, nothing is read from the environment.
  const config = JSON.parse(process.env.CYCLE_ADAPTER_CONFIG ?? "{}") as EchoConfig;
  const fake = fakeAgent({
    onPrompt: async (turn) => {
      // What this process was started with and asked to do is said back, for the test to read as the client.
      const started = fake.log.resumes.length > 0 ? "resumed" : "new";
      await turn.say({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: { type: "text", text: `${config.greeting} ${started}: ${turn.prompt}` },
      });
    },
  });
  const { target } = await fake.definition.launch();
  const stream = ndJsonStream(
    new WritableStream({
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    }),
    new ReadableStream({
      start(controller) {
        process.stdin.on("data", (chunk) =>
          controller.enqueue(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
          ),
        );
        process.stdin.on("end", () => controller.close());
      },
    }),
  );
  await (target as AgentApp).connect(stream).closed;
};

export const ECHO_MAIN = new URL(import.meta.url).pathname;

export const echoHarness: Harness = {
  id: "echo",
  name: "Echo",
  runAdapter,
  definition: ({ inherited, self }) =>
    processAgent({
      id: "echo",
      name: "Echo",
      command: [...self, "adapter", "echo"],
      env: {
        PATH: inherited.PATH ?? "",
        CYCLE_ADAPTER_CONFIG: JSON.stringify({ greeting: "echo" } satisfies EchoConfig),
      },
    }),
};

if (import.meta.main) await runCli(Bun.argv.slice(2), [echoHarness]);

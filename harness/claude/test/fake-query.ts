import type {
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** What a turn is asked to do: the text of the user message that began it, and the options of its query. */
export type Call = { prompt: string; options: Options };

const delta = (index: number, text: string) =>
  ({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  }) as unknown as SDKMessage;

/** The messages of a turn in which Claude answers with `text`, as the SDK sends them. */
export const textTurn = (sessionId: string, messageId: string, text: string): SDKMessage[] =>
  [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "stream_event", event: { type: "message_start", message: { id: messageId } } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    delta(0, text.slice(0, 3)),
    delta(0, text.slice(3)),
    {
      type: "assistant",
      message: { id: messageId, content: [{ type: "text", text }] },
    },
    { type: "result", subtype: "success", stop_reason: "end_turn", session_id: sessionId },
  ] as unknown as SDKMessage[];

const textOfInput = (message: SDKUserMessage): string => {
  const content = (message.message as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
};

/**
 * A stand-in for the SDK's `query` in streaming-input mode, like the real one: the process lives as
 * long as the input does, each pushed user message gets one scripted turn, `interrupt` ends the turn
 * that is running with an error result and leaves the process up, and an abort or `kill` ends the
 * stream with an error.
 */
export const fakeQuery = (turns: (call: Call) => SDKMessage[] | Promise<SDKMessage[]>) => {
  /** One entry per query started: the first prompt it was given, and its options. */
  const calls: Call[] = [];
  /** Every user message pushed, in order. */
  const prompts: string[] = [];
  /** The same, as the SDK was given them: a string, or content blocks. */
  const contents: unknown[] = [];
  const state = {
    /** What `supportedCommands()` / `initializationResult().commands` answers. */
    commands: [] as { name: string; description: string; argumentHint: string }[],
    /** What `initializationResult().models` / `supportedModels()` answers. */
    availableModels: [] as ModelInfo[],
    /** Make `initializationResult()` reject so fallback queries (`supportedCommands`/`supportedModels`) are exercised. */
    failInitializationResult: false,
    interrupts: 0,
    /** The task ids `stopTask` was called with, in order. */
    stopped: [] as string[],
    /** How long `setPermissionMode` takes, as a process that is busy takes. */
    setterDelayMs: 0,
    permissionModes: [] as string[],
    models: [] as (string | undefined)[],
    flagSettings: [] as Record<string, unknown>[],
    /** Make `setPermissionMode` and `setModel` throw, as they do on a process that is gone. */
    failSetters: false,
    /** What `getContextUsage()` answers (a function: called for each ask); absent: it fails, as on a CLI that does not know it. */
    contextUsage: undefined as unknown,
    /** `interrupt` does nothing, as for a process that has hung. */
    ignoreInterrupt: false,
    /** Messages the newest query's process says by itself, with no prompt (a background task woke it). */
    say: (_messages: SDKMessage[]): void => undefined,
    /** Makes the newest query's stream end with an error, as if its process had died. */
    kill: (_error?: Error): void => undefined,
    /** True when the newest query's input was closed (the adapter let it go). */
    inputClosed: false,
    /**
     * A message pushed with priority "next" while a turn runs is taken into that turn, as Claude does
     * at a tool call; otherwise it waits and gets a turn of its own, as when the turn ends first.
     */
    fold: false,
    /** The texts taken into a running turn, in order. */
    folded: [] as string[],
    /** A process that has been let go takes this long to exit: its stream ends when this settles. */
    holdExit: undefined as Promise<void> | undefined,
    /** Results say nothing of what they took, as the SDK's failed results do. */
    dropUuids: false,
  };
  const run = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options: Options;
  }): Query => {
    const { options } = params;
    const input =
      typeof params.prompt === "string"
        ? (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: params.prompt },
            } as SDKUserMessage;
          })()
        : params.prompt;
    state.inputClosed = false;
    // An interrupt that arrives before the process has picked the message up is not lost.
    let interruptedEarly = false;
    let interrupt: () => void = () => {
      interruptedEarly = true;
    };
    const signal = options.abortController?.signal;
    const ended = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      state.kill = (error) => reject(error ?? new Error("the Claude process died"));
    });
    ended.catch(() => undefined);

    // The input is read as it comes, as the CLI reads its stdin, so a message can arrive mid-turn.
    const buffer: SDKUserMessage[] = [];
    let inputDone = false;
    let arrived: (() => void) | undefined;
    void (async () => {
      for await (const message of input) {
        buffer.push(message);
        arrived?.();
      }
      inputDone = true;
      arrived?.();
    })();
    const said: SDKMessage[][] = [];
    state.say = (messages) => {
      said.push(messages);
      arrived?.();
    };
    const next = async (): Promise<SDKUserMessage | SDKMessage[] | undefined> => {
      while (buffer.length === 0 && said.length === 0 && !inputDone) {
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
      return said.shift() ?? buffer.shift();
    };

    const iterator = (async function* () {
      for (;;) {
        // A process that has been killed reads nothing more, even what was already sent to it.
        const message = await Promise.race([ended, next()]);
        if (message === undefined) {
          state.inputClosed = true;
          await state.holdExit;
          return;
        }
        if (Array.isArray(message)) {
          for (const own of message) yield own;
          continue;
        }
        const pushed = { value: message };
        const text = textOfInput(pushed.value);
        prompts.push(text);
        contents.push((pushed.value.message as { content: unknown }).content);
        if (calls.at(-1)?.options !== options) calls.push({ prompt: text, options });
        const interrupted = new Promise<"interrupted">((resolve) => {
          interrupt = () => resolve("interrupted");
          if (interruptedEarly) resolve("interrupted");
          interruptedEarly = false;
        });
        const messages = await Promise.race([
          Promise.resolve().then(() => turns({ prompt: text, options })),
          interrupted,
          ended,
        ]);
        if (messages === "interrupted") {
          const own = (pushed.value as { uuid?: string }).uuid;
          yield {
            type: "result",
            subtype: "error_during_execution",
            stop_reason: null,
            ...(own !== undefined ? { user_message_uuids: [own] } : {}),
          } as unknown as SDKMessage;
          continue;
        }
        const own = (pushed.value as { uuid?: string }).uuid;
        for (const message of messages) {
          if (message.type !== "result" || own === undefined) {
            yield message;
            continue;
          }
          const taken = [own];
          for (const waiting of state.fold ? [...buffer] : []) {
            if ((waiting as { priority?: string }).priority !== "next") continue;
            buffer.splice(buffer.indexOf(waiting), 1);
            const said = textOfInput(waiting);
            prompts.push(said);
            contents.push((waiting.message as { content: unknown }).content);
            state.folded.push(said);
            taken.push((waiting as { uuid?: string }).uuid ?? "");
          }
          yield (
            state.dropUuids ? message : { ...message, user_message_uuids: taken }
          ) as SDKMessage;
        }
      }
    })();
    return Object.assign(iterator, {
      stopTask: async (taskId: string) => {
        state.stopped.push(taskId);
      },
      interrupt: async () => {
        state.interrupts++;
        if (!state.ignoreInterrupt) interrupt();
      },
      setPermissionMode: async (mode: string) => {
        if (state.setterDelayMs > 0) await new Promise((r) => setTimeout(r, state.setterDelayMs));
        if (state.failSetters) throw new Error("the process is gone");
        state.permissionModes.push(mode);
      },
      supportedCommands: async () => state.commands,
      getContextUsage: async () => {
        if (state.contextUsage === undefined) throw new Error("unknown control request");
        return typeof state.contextUsage === "function" ? state.contextUsage() : state.contextUsage;
      },
      supportedModels: async () => state.availableModels,
      initializationResult: async () => {
        if (state.failInitializationResult) throw new Error("initializationResult unavailable");
        return {
          commands: state.commands,
          models: state.availableModels,
          agents: [],
          output_style: "default",
          available_output_styles: [],
          account: {},
        };
      },
      setModel: async (model?: string) => {
        if (state.failSetters) throw new Error("the process is gone");
        state.models.push(model);
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        if (state.failSetters) throw new Error("the process is gone");
        state.flagSettings.push(settings);
      },
    }) as unknown as Query;
  };
  return { calls, prompts, contents, run, state };
};

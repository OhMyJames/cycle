import {
  type MadeSandbox,
  type SandboxBook,
  type SandboxSpec,
  SbxSandboxes,
  type SpawnedProcess,
  plainSpec,
} from "../src/index.ts";

/** A process that does nothing until a test ends it. */
export function fakeProcess(): { process: SpawnedProcess; exit(): void } {
  const listeners: (() => void)[] = [];
  const process = {
    once: (_event: string, listener: () => void) => void listeners.push(listener),
  } as unknown as SpawnedProcess;
  return { process, exit: () => listeners.splice(0).forEach((listener) => listener()) };
}

/** The owner's environments and what was made of them, in memory. */
export function fakeBook(specs: SandboxSpec[] = [plainSpec("standard")]) {
  const made: Record<string, MadeSandbox> = {};
  const book: SandboxBook = {
    environment: (id) => specs.find((spec) => spec.id === id) ?? null,
    made: (name) => made[name] ?? null,
    allMade: () => ({ ...made }),
    setMade: (name, value) => {
      if (value) made[name] = value;
      else delete made[name];
    },
  };
  return { book, specs, made };
}

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * An `sbx` that runs nothing: it keeps the sandboxes, saved sandboxes and secrets its commands
 * would leave, and what it was asked, each with what was added to its environment and its input.
 */
export function fakeSbx(names: string[] = [], specs?: SandboxSpec[]) {
  const asked: string[][] = [];
  const given: { args: string[]; env?: Record<string, string>; input?: string }[] = [];
  const folders: string[] = [];
  const templates: string[] = [];
  const secrets: string[] = [];
  const started: ReturnType<typeof fakeProcess>[] = [];
  const logged: string[] = [];
  /** `fail` fails every command with this; `failing` fails the commands that begin with it. */
  const state = { installed: true, fail: "", failing: "" };
  const { book, made } = fakeBook(specs);
  const sandboxes = new SbxSandboxes(
    {
      which: () => (state.installed ? "/usr/local/bin/sbx" : null),
      run: async (args, more) => {
        asked.push(args);
        given.push({ args, ...more });
        const line = args.filter((arg) => arg !== "--no-input").join(" ");
        if (state.fail) return { exitCode: 1, stdout: "", stderr: `progress\n${state.fail}\n` };
        if (state.failing && line.startsWith(state.failing)) {
          return { exitCode: 1, stdout: "", stderr: `it broke\n` };
        }
        if (line === "ls -q") return ok(`${names.join("\n")}\n`);
        if (line.startsWith("create ")) names.push(args[args.indexOf("--name") + 1] ?? "");
        if (line.startsWith("rm ")) names.splice(names.indexOf(args.at(-1) ?? ""), 1);
        if (line === "template ls -q") return ok(templates.join("\n"));
        if (line.startsWith("template save ")) templates.push(args.at(-1) ?? "");
        if (line.startsWith("template rm ")) templates.splice(templates.indexOf(args[2] ?? ""), 1);
        if (line.startsWith("secret ls")) return ok(secrets.join("\n"));
        if (line.startsWith("secret set ")) secrets.push(args[2] ?? "");
        return ok();
      },
      start: (args) => {
        asked.push(args);
        const one = fakeProcess();
        started.push(one);
        return one.process;
      },
      makeFolder: async (path) => void folders.push(path),
      log: (line) => void logged.push(line),
    },
    "/home/me/.claude",
    book,
  );
  /** What was asked, each as one line, without the listings. */
  const did = () =>
    asked
      .map((args) => args.filter((arg) => arg !== "--no-input").join(" "))
      .filter((line) => !/^(ls|template ls|secret ls)\b/.test(line));
  return { sandboxes, asked, given, did, folders, templates, started, logged, state, made, names };
}

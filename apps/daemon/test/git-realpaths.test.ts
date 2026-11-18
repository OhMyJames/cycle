import { expect, test } from "bun:test";
import type { ExecResult } from "@cycle/protocol";
import { Git } from "../src/git.ts";

function gitSaying(result: ExecResult | Error) {
  const runs: { argv: string[]; cwd: string | undefined }[] = [];
  const git = new Git(async (argv, options) => {
    runs.push({ argv, cwd: options.cwd });
    if (result instanceof Error) throw result;
    return result;
  });
  return { git, runs };
}

const said = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "" });

test("each path comes back as the machine names it, in the order given, asked in one run", async () => {
  const { git, runs } = gitSaying(said("/real/a\n/real/b\n"));
  expect(await git.realpaths("/cwd", ["/link/a", "/link/b"])).toEqual(["/real/a", "/real/b"]);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.cwd).toBe("/cwd");
  // The paths are arguments after the script, never part of it.
  expect(runs[0]?.argv.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(runs[0]?.argv.slice(4)).toEqual(["/link/a", "/link/b"]);
  expect(runs[0]?.argv[2]).not.toContain("/link/a");
});

test("a folder the machine cannot resolve comes back as given, and the others still resolve", async () => {
  const { git } = gitSaying(said("/real/a\n\n/real/c\n"));
  expect(await git.realpaths("/cwd", ["/link/a", "/gone", "/link/c"])).toEqual([
    "/real/a",
    "/gone",
    "/real/c",
  ]);
});

test("an answer that does not fit the question is not believed", async () => {
  const given = ["/a", "/b"];
  expect(await gitSaying(said("")).git.realpaths("/cwd", given)).toEqual(given);
  expect(await gitSaying(said("/x\n/y\n", 1)).git.realpaths("/cwd", given)).toEqual(given);
  expect(await gitSaying(new Error("no machine")).git.realpaths("/cwd", given)).toEqual(given);
});

test("a path with a newline is not asked about, since its answer could not be told apart", async () => {
  const { git, runs } = gitSaying(said("/x\n/y\n"));
  expect(await git.realpaths("/cwd", ["/a\nb", "/c"])).toEqual(["/a\nb", "/c"]);
  expect(runs).toEqual([]);
});

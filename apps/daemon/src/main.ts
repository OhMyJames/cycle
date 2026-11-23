#!/usr/bin/env bun
import { runCli } from "./cli.ts";
import { HARNESSES } from "./harnesses.ts";

await runCli(Bun.argv.slice(2), HARNESSES);

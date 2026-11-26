import { expect, test } from "bun:test";
import { testLayers } from "../src/layers.ts";

const names = (files: string[]) => testLayers(files).map((argv) => argv.slice(2).join(" "));

test("every change runs the gate", () => {
  expect(names(["README.md"])).toEqual(["check"]);
  expect(names([])).toEqual(["check"]);
});

test("the interface adds the browser tests", () => {
  expect(names(["packages/ui/src/x.tsx"])).toEqual(["check", "test:browser"]);
  expect(names(["apps/desktop/src/renderer/a.ts"])).toEqual(["check", "test:browser"]);
});

test("the protocol, daemon, harness and desktop core add the integration tests", () => {
  for (const file of [
    "docs/protocol.md",
    "packages/protocol/src/a.ts",
    "apps/daemon/src/a.ts",
    "harness/agy/src/a.ts",
    "apps/desktop/src/main/a.ts",
  ]) {
    expect(names([file])).toEqual(["check", "test:integration"]);
  }
});

test("a change in both adds both, in order", () => {
  expect(names(["packages/ui/a.ts", "apps/daemon/b.ts"])).toEqual([
    "check",
    "test:browser",
    "test:integration",
  ]);
});

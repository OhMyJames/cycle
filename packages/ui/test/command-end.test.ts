import { expect, test } from "bun:test";
import { endOf } from "../src/react/tool.tsx";

const facts = (run?: object) => ({ images: [], links: [], ...(run ? { run } : {}) }) as never;

test("a command's head says how it ended, and nothing for one its line says was cut short or sent away", () => {
  expect(endOf("completed", facts({}))).toEqual({ ok: true });
  expect(endOf("failed", facts({ exitCode: 2 }))).toEqual({ ok: false, code: 2 });
  expect(endOf("failed", facts())).toEqual({ ok: false });
  expect(endOf("failed", facts({ interrupted: true, exitCode: 137 }))).toBeUndefined();
  expect(endOf("completed", facts({ background: true }))).toBeUndefined();
  expect(endOf("completed", facts({ timedOutMs: 1000, background: true }))).toBeUndefined();
  expect(endOf("in_progress", facts())).toBeUndefined();
  expect(endOf("completed", facts())).toBeUndefined();
});

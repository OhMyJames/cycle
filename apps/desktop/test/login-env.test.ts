import { expect, test } from "bun:test";
import { parseLoginEnv } from "../src/login-env";

const wrap = (body: string) => `__CYCLE_ENV_START_t__${body}__CYCLE_ENV_END_t__`;

test("the environment is found between the markers, whatever a profile prints around it", () => {
  const stdout = `Welcome back!\n${wrap("PATH=/opt/bin:/usr/bin\0NOTE=two\nlines\0A=b=c\0")}bye\n`;
  expect(parseLoginEnv(stdout, "t")).toEqual({
    PATH: "/opt/bin:/usr/bin",
    NOTE: "two\nlines",
    A: "b=c",
  });
});

test("what is not a variable is left out, and an unfinished print gives nothing", () => {
  expect(parseLoginEnv(wrap("BASH_FUNC_x%%=() { :; }\0novalue\0OK=1\0"), "t")).toEqual({ OK: "1" });
  expect(parseLoginEnv("__CYCLE_ENV_START_t__PATH=/bin\0", "t")).toBeUndefined();
  expect(parseLoginEnv(wrap("PATH=/bin\0"), "other")).toBeUndefined();
});

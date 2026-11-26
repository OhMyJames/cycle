import { expect, test } from "bun:test";
import { deliverEnv, verifyEnv } from "../src/env.ts";

const source = {
  PATH: "/bin",
  HOME: "/home/u",
  GH_TOKEN: "gh",
  SSH_AUTH_SOCK: "/s",
  AUTO_LOOP_PLAN_KEY: "secret",
  ANTHROPIC_API_KEY: "secret",
};

test("commands that run session-written code see no credentials", () => {
  const env = verifyEnv(source);
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", CI: "1" });
});

test("push and pr create see git's credentials and nothing of the tracker's or a model's", () => {
  const env = deliverEnv(source);
  expect(env.GH_TOKEN).toBe("gh");
  expect(env.SSH_AUTH_SOCK).toBe("/s");
  expect(Object.keys(env)).not.toContain("AUTO_LOOP_PLAN_KEY");
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
});

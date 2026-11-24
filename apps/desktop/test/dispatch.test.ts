import { describe, expect, test } from "bun:test";
import { dispatch, type Handlers, MAIN_METHODS, type ManagerApi } from "../src/main/dispatch.ts";

/** Main's handlers, each answering with its own name and what it was given. */
const own = (): Handlers =>
  Object.fromEntries(
    MAIN_METHODS.map((method) => [method, (...args: unknown[]) => ({ main: method, args })]),
  ) as Handlers;

/** A manager with only `sessions`: the rest of its methods are missing, as a mistake would leave them. */
const partial = {
  sessions(this: unknown, environmentId: unknown) {
    return { manager: "sessions", environmentId, self: this === partial };
  },
} as unknown as ManagerApi;

describe("dispatch", () => {
  test("a method that is not the app's is refused", () => {
    const call = dispatch(partial, own());
    expect(() => call("constructor", [])).toThrow(
      "Refused: constructor is not a method of the app",
    );
  });

  test("main's methods go to main, with what the page sent, even signed out", () => {
    const call = dispatch(partial, own(), () => false);
    expect(call("track", ["x", { a: 1 }])).toEqual({ main: "track", args: ["x", { a: 1 }] });
  });

  test("the manager's methods go to the manager, as its own method", () => {
    const call = dispatch(partial, own());
    expect(call("sessions", ["local"])).toEqual({
      manager: "sessions",
      environmentId: "local",
      self: true,
    });
  });

  test("signed out, the manager's methods are refused", () => {
    const call = dispatch(partial, own(), () => false);
    expect(() => call("sessions", ["local"])).toThrow("Refused: sign in to Cycle first");
  });

  test("a method the manager lacks fails, instead of answering undefined", () => {
    const call = dispatch(partial, own());
    expect(() => call("agents", ["local"])).toThrow("agents is not answered here");
  });

  test("a method main lacks fails, instead of answering undefined", () => {
    const { saveImage: _, ...rest } = own();
    const call = dispatch(partial, rest as Handlers);
    expect(() => call("saveImage", [])).toThrow("saveImage is not answered here");
  });
});

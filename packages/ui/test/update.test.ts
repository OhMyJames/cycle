import { expect, test } from "bun:test";
import type { UpdateState } from "../src/client/host.ts";
import { updateOffer } from "../src/lib/update.ts";

const at = (
  state: UpdateState extends infer S ? (S extends unknown ? Omit<S, "current"> : never) : never,
) => ({ current: "0.1.0", ...state }) as UpdateState;

test.each<[UpdateState, string, "check" | "install" | null]>([
  [at({ status: "idle" }), "Check for updates", "check"],
  [at({ status: "checking" }), "Checking…", null],
  [at({ status: "upToDate", checkedAt: 1 }), "Check for updates", "check"],
  [at({ status: "downloading", version: "0.2.0", progress: 0.429 }), "Downloading 42%", null],
  [at({ status: "ready", version: "0.2.0" }), "Restart to update", "install"],
  [at({ status: "error", message: "GitHub answered 500." }), "Check for updates", "check"],
])("%j offers %s", (state, label, action) => {
  const offer = updateOffer(state);
  expect(offer.label).toBe(label);
  expect(offer.action).toBe(action);
  expect(offer.primary).toBe(action === "install");
});

test("a ready update says what restarting costs, or why it was refused", () => {
  expect(updateOffer(at({ status: "ready", version: "0.2.0" })).note).toBe(
    "Version 0.2.0 is ready. Restarting stops any turn that is running.",
  );
  const refused = at({
    status: "ready",
    version: "0.2.0",
    message: "/Applications cannot be written.",
  });
  expect(updateOffer(refused).note).toBe("/Applications cannot be written.");
  expect(updateOffer(at({ status: "error", message: "offline" })).note).toBe("offline");
});

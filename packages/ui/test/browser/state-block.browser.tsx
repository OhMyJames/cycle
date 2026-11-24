import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { StateBlock } from "../../src/react/state-block.tsx";

afterEach(cleanup);

test("a failure is said at once, with the system's own words apart and a way on", async () => {
  const user = userEvent.setup();
  let tried = 0;
  const { container } = render(
    <StateBlock
      tone="error"
      title="Not connected to this location."
      reason="ssh: connect to host build-1 port 22: Connection refused"
      action={{ label: "Connect again", onAction: () => tried++ }}
    />,
  );
  const alert = within(container).getByRole("alert");
  expect(alert.textContent).toContain("Not connected to this location.");
  // The reason is not retyped into the sentence: it is its own monospace block, to select and copy.
  const reason = alert.querySelector("code");
  expect(reason?.textContent).toBe("ssh: connect to host build-1 port 22: Connection refused");
  expect(alert.querySelector('[data-slot="state-title"]')?.textContent).not.toContain("refused");
  await user.click(within(container).getByRole("button", { name: "Connect again" }));
  expect(tried).toBe(1);
});

test("loading is a polite status that says it is busy; empty is plain text", () => {
  const { container, rerender } = render(<StateBlock tone="loading" title="Reading the folder…" />);
  const status = within(container).getByRole("status");
  expect(status.getAttribute("aria-busy")).toBe("true");
  expect(status.querySelector('[data-slot="spinner"]')).not.toBeNull();

  rerender(<StateBlock tone="empty" size="inline" title="There are no folders here." />);
  expect(within(container).queryByRole("status")).toBeNull();
  expect(within(container).queryByRole("alert")).toBeNull();
  expect(within(container).getByText("There are no folders here.")).toBeTruthy();
});

test("an away location is a status with what to do next", () => {
  const { container } = render(
    <StateBlock
      tone="away"
      title="No agent is available on build-1."
      body="Install Claude Code there, or sign in."
      action={{ label: "Check again", onAction: () => {} }}
    />,
  );
  const status = within(container).getByRole("status");
  expect(status.textContent).toContain("Install Claude Code there");
  expect(within(container).getByRole("button", { name: "Check again" })).toBeTruthy();
});

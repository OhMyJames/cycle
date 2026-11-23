import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { server, userEvent } from "vitest/browser";
import { StoreProvider } from "../../src/react/index.ts";
import { FOLD_OVER, Markdown } from "../../src/react/markdown.tsx";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { LONG_CODE_LINES, READING, READING_STREAMING } from "../markdown-samples.ts";

afterEach(cleanup);

const html = (text: string) => render(<Markdown text={text} />).container;

test("renders markdown", async () => {
  const c = html(
    "# Title\n\nSome **bold** text and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```",
  );
  expect(c.querySelector("h1")?.textContent).toBe("Title");
  // Streamdown draws bold as a styled span, not <strong>.
  expect(c.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
  expect(c.querySelectorAll("li")).toHaveLength(2);
  await waitFor(() => expect(c.textContent).toContain("const x = 1;"));
});

test("drops raw HTML instead of putting it in the page", () => {
  const c = html(
    'Hello <script>window.__pwned = 1</script><img src="https://evil.example/x.png" onerror="window.__pwned = 2"> <iframe src="https://evil.example"></iframe> <style>body{display:none}</style>',
  );
  expect(c.querySelector("script")).toBeNull();
  expect(c.querySelector("iframe")).toBeNull();
  expect(c.querySelector("style")).toBeNull();
  expect(c.querySelector("img")).toBeNull();
  expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
});

test("never loads an image: a markdown image becomes text", () => {
  const c = html("![a diagram](https://evil.example/pixel.png)");
  expect(c.querySelector("img")).toBeNull();
  expect(c.textContent).toContain("[image not loaded: a diagram]");
});

test("a link to the web opens as a link that cannot reach back", () => {
  const c = html("[docs](https://example.com/docs)");
  const a = c.querySelector("a");
  expect(a?.getAttribute("href")).toBe("https://example.com/docs");
  expect(a?.getAttribute("target")).toBe("_blank");
  expect(a?.getAttribute("rel")).toContain("noopener");
  expect(a?.getAttribute("rel")).toContain("noreferrer");
});

test("a link to anything but http, https and mailto is only text", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "vbscript:x",
  ]) {
    const c = html(`[click](${href})`);
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("click");
  }
});

test("half a message streams without breaking the page", () => {
  const c = render(<Markdown text={"A list:\n\n- one\n- **tw"} streaming />).container;
  expect(c.textContent).toContain("one");
  expect(c.textContent).toContain("tw");
});

test("Tailwind has the classes the markup uses, or it would be drawn bare", async () => {
  // Read from disk by the test runner (the path is from this package's root): the page itself cannot.
  const css = await server.commands.readFile("src/styles/built.css");
  const c = html(
    "# T\n\n- a\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nx\n```\n\n[l](https://e.com)",
  );
  const used = new Set<string>();
  for (const el of Array.from(c.querySelectorAll("[class]"))) {
    for (const name of el.getAttribute("class")?.split(/\s+/) ?? []) {
      // The plain utilities, which are what a missing @source loses.
      if (/^[a-z]+(-[a-z0-9]+)*$/.test(name) && !name.startsWith("language-")) used.add(name);
    }
  }
  const missing = [...used].filter((name) => !css.includes(`.${name}`));
  expect(used.size).toBeGreaterThan(3);
  expect(missing).toEqual([]);
});

const codeBlock = (c: HTMLElement) => c.querySelector('[data-streamdown="code-block"]');

test("a long code block read again is shown in part, and whole on request", async () => {
  const user = userEvent.setup();
  const c = html(READING);
  const fold = c.querySelector('[data-slot="code-fold-toggle"]')?.parentElement;
  expect(fold?.hasAttribute("data-folded")).toBe(true);
  const more = within(fold as HTMLElement).getByRole("button", {
    name: `Show all ${LONG_CODE_LINES} lines`,
  });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(FOLD_OVER).toBeLessThan(LONG_CODE_LINES);
  await user.click(more);
  expect(fold?.hasAttribute("data-folded")).toBe(false);
  expect(more.textContent).toBe("Show fewer lines");
  expect(more.getAttribute("aria-expanded")).toBe("true");
  // Shown in part or whole, the code is all there: Copy and find-in-page get every line.
  await waitFor(() => expect(c.textContent).toContain(`step ${LONG_CODE_LINES - 2}:`));
});

test("a short code block has nothing to fold", () => {
  const c = html("```ts\nconst a = 1;\n```");
  expect(c.querySelector('[data-slot="code-fold-toggle"]')).toBeNull();
  expect(c.querySelector("[data-folded]")).toBeNull();
});

test("a block written on screen stays whole and stays the same block when the reply ends", async () => {
  const r = render(<Markdown text={READING_STREAMING} streaming />);
  await waitFor(() => expect(codeBlock(r.container)).not.toBeNull());
  const block = codeBlock(r.container);
  const heading = r.container.querySelector("h2");
  r.rerender(<Markdown text={READING} streaming />);
  r.rerender(<Markdown text={READING} />);
  // Not drawn again: the static mode was another tree, and every code block was coloured afresh.
  expect(codeBlock(r.container)).toBe(block);
  expect(r.container.querySelector("h2")).toBe(heading);
  // Not shrunk under the reader as the reply ends; it can still be put in part.
  expect(r.container.querySelector("[data-folded]")).toBeNull();
  expect(screen.getByRole("button", { name: "Show fewer lines" })).toBeTruthy();
});

test("a table that is being written never shows its pipes", () => {
  for (const text of ["Results:\n\n| Case | After |", "Results:\n\n| Case | After |\n| -"]) {
    const c = render(<Markdown text={text} streaming />).container;
    expect(c.textContent).not.toContain("|");
    cleanup();
  }
  const c = render(<Markdown text={"| Case | After |\n| -"} streaming />).container;
  expect(c.querySelector("table")).not.toBeNull();
});

test("a link in a message asks before it opens, showing where it goes", async () => {
  const user = userEvent.setup();
  const opened: unknown[][] = [];
  const windowOpen = window.open;
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as typeof window.open;
  try {
    const c = html("[the docs](https://example.com/a?b=c)");
    await user.click(within(c).getByRole("link", { name: "the docs" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("https://example.com/a?b=c");
    expect(opened).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(opened).toEqual([]);
    await user.click(within(c).getByRole("link", { name: "the docs" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Open link" }),
    );
    expect(opened).toEqual([["https://example.com/a?b=c", "_blank", "noopener,noreferrer"]]);
  } finally {
    window.open = windowOpen;
  }
});

test("a link to a relative path is its words: not a link, and not marked as blocked", () => {
  const c = html("Fixed in [the manager](apps/daemon/src/connection-manager.ts).");
  expect(c.querySelector("a")).toBeNull();
  expect(c.textContent).toBe("Fixed in the manager.");
});

test("opening a link and showing a long block whole are counted, and nothing of either is sent", async () => {
  const user = userEvent.setup();
  const script = fakeBridge({ connected: true });
  const windowOpen = window.open;
  window.open = (() => null) as typeof window.open;
  try {
    const c = render(
      <StoreProvider store={new AppStore(script.bridge)}>
        <Markdown text={`${READING}\n\n[secret place](https://example.com/private-path)`} />
      </StoreProvider>,
    ).container;
    await user.click(within(c).getByRole("button", { name: `Show all ${LONG_CODE_LINES} lines` }));
    await user.click(within(c).getByRole("button", { name: "Show fewer lines" }));
    await user.click(within(c).getByRole("link", { name: "secret place" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Open link" }),
    );
  } finally {
    window.open = windowOpen;
  }
  const tracked = script.calls.filter(([name]) => name === "track");
  // Showing it in part again is not counted; neither event says which block, which link or where it went.
  expect(tracked).toEqual([
    ["track", "code_block_expanded", {}],
    ["track", "message_link_opened", {}],
  ]);
});

test("a code block's Copy goes through main, copies all of it, and says it did", async () => {
  const user = userEvent.setup();
  const script = fakeBridge({ connected: true });
  const c = render(
    <StoreProvider store={new AppStore(script.bridge)}>
      <Markdown text={READING} />
    </StoreProvider>,
  ).container;
  const buttons = within(c).getAllByRole("button", { name: "Copy the code" });
  // Ours, not Streamdown's, which wrote to the page's own clipboard.
  expect(c.querySelector('[data-streamdown="code-block-copy-button"]')).toBeNull();
  const last = buttons.at(-1);
  if (last === undefined) throw new Error("no Copy");
  await user.click(last);
  const copied = script.calls.filter(([name]) => name === "copyText");
  expect(copied).toHaveLength(1);
  // The whole block, though it is shown in part.
  expect(String(copied[0]?.[1]).split("\n")).toHaveLength(LONG_CODE_LINES);
  await waitFor(() => expect(c.querySelector('[data-copied="done"]')).not.toBeNull());
});

test("no height cap of Streamdown's: shown whole, a long block is all there, not scrolled inside itself", () => {
  const c = html(READING);
  for (const body of Array.from(c.querySelectorAll('[data-streamdown="code-block-body"]'))) {
    expect((body as HTMLElement).style.maxHeight).not.toBe("400px");
  }
});

test("a long block that arrives whole while the reply is written is not folded under the reader", () => {
  const c = render(<Markdown text={READING} streaming />).container;
  expect(c.querySelector("[data-folded]")).toBeNull();
});

test("a finished reply is drawn as written: an unclosed mark is not completed", () => {
  const c = html("Use a**b for powers, and **note");
  expect(c.querySelector('[data-streamdown="strong"]')).toBeNull();
  expect(c.textContent).toContain("**note");
});

test("a reply's blocks are 12px apart whatever they are, paragraphs and code alike, and take no margin of their own", async () => {
  const c = render(
    <div data-slot="message" data-role="agent">
      <Markdown text={"First.\n\nSecond.\n\n```\nplain\n```\n\nThird."} />
    </div>,
  ).container;
  const root = c.querySelector<HTMLElement>("[data-markdown]");
  expect(root).not.toBeNull();
  expect(getComputedStyle(root as HTMLElement).rowGap).toBe("12px");
  await waitFor(() => expect(c.textContent).toContain("plain"));
  const [first, second, third] = [...c.querySelectorAll("p")];
  for (const block of [first, second, third, ...(root?.children ?? [])])
    expect(getComputedStyle(block as Element).marginBlockStart).toBe("0px");
  const gap =
    (second as HTMLElement).getBoundingClientRect().top -
    (first as HTMLElement).getBoundingClientRect().bottom;
  expect(gap).toBe(12);
});

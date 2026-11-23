import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from "lexical";
import { type ReactElement, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { markdownOf } from "../../src/composer-markdown.ts";
import { type InputKey, MarkdownInput } from "../../src/react/markdown-input.tsx";

afterEach(cleanup);

const editorOf = (box: HTMLElement): LexicalEditor =>
  (box as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;

const insert = (box: HTMLElement, words: string) =>
  act(() => {
    editorOf(box).update(
      () => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertRawText(words);
      },
      { discrete: true },
    );
  });

type Seen = { keys: InputKey[]; changes: string[]; files: File[] };

/** The input with a parent that keeps the text, as the composer does. */
function Parent({
  start,
  disabled,
  seen,
  setter,
}: {
  start: string;
  disabled: boolean;
  seen: Seen;
  setter: { current: (text: string) => void };
}): ReactElement {
  const [value, set] = useState(start);
  setter.current = set;
  return (
    <MarkdownInput
      value={value}
      onChange={(markdown) => {
        seen.changes.push(markdown);
        set(markdown);
      }}
      disabled={disabled}
      label="Message"
      placeholder="Message the agent"
      onKey={(key, event) => {
        seen.keys.push(key);
        // As the composer does when the agent is idle: Enter is used, Shift+Enter is left.
        return key === "escape" || (key === "enter" && !event.shiftKey);
      }}
      onPasteFiles={(files) => seen.files.push(...files)}
    />
  );
}

/** Mounts it, and gives back what it was told, and a way to change the text from outside. */
const mount = (start = "", options: { disabled?: boolean } = {}) => {
  const seen: Seen = { keys: [], changes: [], files: [] };
  const setter = { current: (_text: string) => {} };
  render(<Parent start={start} disabled={options.disabled ?? false} seen={seen} setter={setter} />);
  return { seen, set: (text: string) => act(() => setter.current(text)) };
};

test("what it starts with is shown as it reads, and the text is what was given", async () => {
  mount("**bold** and my_file.py");
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(box.querySelector("strong")?.textContent).toBe("bold");
  expect(box.textContent).toBe("bold and my_file.py");
  expect(markdownOf(editorOf(box))).toBe("**bold** and my_file.py");
});

test("writing tells the parent the Markdown, and not what the parent itself put there", async () => {
  const { seen } = mount("");
  const box = await screen.findByRole("textbox", { name: "Message" });
  await insert(box, "hello **there**");
  expect(seen.changes.at(-1)).toBe("hello **there**");
  const before = seen.changes.length;
  // The parent sends the same text back as the new value: nothing is said again.
  await act(async () => {});
  expect(seen.changes.length).toBe(before);
});

test("a text that comes from outside replaces the document", async () => {
  const { set, seen } = mount("first");
  const box = await screen.findByRole("textbox", { name: "Message" });
  set("second one");
  await waitFor(() => expect(markdownOf(editorOf(box))).toBe("second one"));
  expect(seen.changes).toEqual([]);
  set("");
  await waitFor(() => expect(markdownOf(editorOf(box))).toBe(""));
});

test("Enter is asked of the parent, with or without a modifier; one it does not use is a line break", async () => {
  const { seen } = mount("a");
  const box = await screen.findByRole("textbox", { name: "Message" });
  const plain = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  act(() => {
    editorOf(box).dispatchCommand(KEY_ENTER_COMMAND, plain);
  });
  expect(seen.keys).toEqual(["enter"]);
  expect(plain.defaultPrevented).toBe(true);
  expect(markdownOf(editorOf(box))).toBe("a");
  const shifted = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
  act(() => {
    editorOf(box).update(() => $getRoot().selectEnd(), { discrete: true });
    editorOf(box).dispatchCommand(KEY_ENTER_COMMAND, shifted);
  });
  expect(seen.keys).toEqual(["enter", "enter"]);
  expect(shifted.defaultPrevented).toBe(true);
  // A line break in the same paragraph, not a new paragraph.
  await waitFor(() => expect(box.querySelectorAll("p")).toHaveLength(1));
  expect(box.querySelector("br")).not.toBeNull();
  const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true });
  act(() => {
    editorOf(box).dispatchCommand(KEY_ENTER_COMMAND, composing);
  });
  expect(seen.keys).toEqual(["enter", "enter"]);
});

test("in a list, a new line is the next item, and one on an empty item ends the list", async () => {
  mount("1. first");
  const box = await screen.findByRole("textbox", { name: "Message" });
  const shiftEnter = () =>
    act(() => {
      editorOf(box).update(() => $getRoot().selectEnd(), { discrete: true });
      editorOf(box).dispatchCommand(
        KEY_ENTER_COMMAND,
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true }),
      );
    });
  shiftEnter();
  insert(box, "second");
  await waitFor(() => expect(box.querySelectorAll("ol > li")).toHaveLength(2));
  expect(markdownOf(editorOf(box))).toBe("1. first\n2. second");
  shiftEnter();
  shiftEnter();
  insert(box, "after");
  await waitFor(() => expect(box.querySelectorAll("ol > li")).toHaveLength(2));
  expect(box.querySelector(":scope > p")?.textContent).toBe("after");
});

test("a list shows its numbers and its bullets", async () => {
  mount("1. first\n2. second\n\n- dot");
  const box = await screen.findByRole("textbox", { name: "Message" });
  const ol = box.querySelector("ol");
  const ul = box.querySelector("ul");
  if (ol === null || ul === null) throw new Error("no lists");
  expect(getComputedStyle(ol).listStyleType).toBe("decimal");
  expect(getComputedStyle(ul).listStyleType).toBe("disc");
});

test("a key the parent uses is not also the editor's", async () => {
  const { seen } = mount("");
  const box = await screen.findByRole("textbox", { name: "Message" });
  const pressed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  act(() => {
    editorOf(box).dispatchCommand(KEY_ESCAPE_COMMAND, pressed);
  });
  expect(seen.keys).toEqual(["escape"]);
  expect(pressed.defaultPrevented).toBe(true);
});

test("pasting a picture hands it over, and pasting text puts the text in as typed", async () => {
  const { seen } = mount("");
  const box = await screen.findByRole("textbox", { name: "Message" });
  const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const picture = {
    clipboardData: { files: [png], getData: () => "" },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  act(() => {
    editorOf(box).dispatchCommand(PASTE_COMMAND, picture);
  });
  expect(seen.files).toEqual([png]);
  act(() => {
    editorOf(box).update(() => $getRoot().selectEnd(), { discrete: true });
  });
  const text = {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? "a_b <i>x</i>" : "<b>other</b>"),
    },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  act(() => {
    editorOf(box).dispatchCommand(PASTE_COMMAND, text);
  });
  await waitFor(() => expect(markdownOf(editorOf(box))).toBe("a_b <i>x</i>"));
});

test("a disabled input cannot be written in", async () => {
  mount("kept", { disabled: true });
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(box.getAttribute("contenteditable")).toBe("false");
});

test("the placeholder shows while there is nothing, and goes when there is", async () => {
  const { set } = mount("");
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(document.querySelector('[data-slot="composer-placeholder"]')?.textContent).toBe(
    "Message the agent",
  );
  set("x");
  await waitFor(() =>
    expect(document.querySelector('[data-slot="composer-placeholder"]')).toBeNull(),
  );
  expect(box.textContent).toBe("x");
});

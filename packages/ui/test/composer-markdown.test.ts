import { expect, test } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import {
  decode,
  encode,
  encodeText,
  markdownOf,
  NODES,
  setMarkdown,
} from "../src/composer-markdown.ts";

const char = (code: number): string => String.fromCharCode(code);

const editor = () =>
  createEditor({
    namespace: "test",
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });

const through = (text: string): string => {
  const e = editor();
  setMarkdown(e, text);
  return markdownOf(e);
};

/** Text that is sent as it was typed. */
const same = [
  "my_file.py",
  "snake_case_name and __init__",
  "foo\\.bar",
  "path/to\\file",
  "2*3*4",
  "a & b &#42; c &amp; d",
  "**bold** and `code` and *it*",
  "~~gone~~",
  "- a\n- b",
  "1. one\n2. two",
  "> quote",
  "# Title\ntext",
  "```ts\nlet a_b = 1;\n```",
  "line1\nline2",
  "line1\n\nline3",
  "  indented",
  "trailing  ",
  `a${char(0x2028)}b`,
  `${char(0xe000)} ${char(0xe001)} ${char(0xe002)} ${char(0xe003)} are not ours`,
  `${char(0xe003)}${char(0xe000)}`,
  "it's 100% [a](b) <b>html</b>",
  "",
];

for (const text of same) {
  test(`${JSON.stringify(text)} is sent as it was typed`, () => {
    expect(through(text)).toBe(text);
  });
}

/** Text put in as text, as typing and pasting do: its characters are not formatting until the document says so. */
const asTypedText = (text: string): string => {
  const e = editor();
  e.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      $getRoot().clear().append(paragraph);
    },
    { discrete: true },
  );
  return markdownOf(e);
};

test("text in the document goes out as it is, whatever characters of Markdown it holds", () => {
  for (const text of [
    "**x** and a*b`c~d",
    "_a_ __b__ \\* \\_",
    "2*3*4",
    "```",
    "~~ ~",
    "* not a list",
  ]) {
    expect(asTypedText(text)).toBe(text);
  }
});

test("formatting is in the document, and the text that goes out is still what was typed", () => {
  const e = editor();
  setMarkdown(e, "**bold**");
  expect(JSON.stringify(e.getEditorState().toJSON())).toContain('"format":1');
  expect(markdownOf(e)).toBe("**bold**");
});

test("underscores never format, and are not escaped", () => {
  const e = editor();
  setMarkdown(e, "_not italic_ and __not bold__");
  expect(JSON.stringify(e.getEditorState().toJSON())).not.toContain('"format":1');
  expect(markdownOf(e)).toBe("_not italic_ and __not bold__");
});

test("a list keeps the marker it was written with", () => {
  expect(through("* item")).toBe("* item");
  expect(through("+ item")).toBe("+ item");
});

const random = (alphabet: string[], seed: number) => {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  return (rounds: number, longest: number) =>
    Array.from({ length: rounds }, () => {
      let text = "";
      for (let j = next() % longest; j > 0; j--) text += alphabet[next() % alphabet.length];
      return text;
    });
};

test("encode and decode are inverses on whatever text, and leave Lexical nothing to rewrite", () => {
  const alphabet = ["a", "_", "\\", "&", "*", "\n", "#", "`", "~"];
  for (const code of [0xe000, 0xe001, 0xe002, 0xe003, 0xe006, 0xe007]) alphabet.push(char(code));
  for (const text of random(alphabet, 7)(500, 12)) {
    expect(decode(encode(text))).toBe(text);
    expect(/[\\&_]/.test(encode(text))).toBe(false);
    expect(decode(encodeText(text))).toBe(text);
  }
});

test("random text of what people type, apart from what would make a block, comes back as typed", () => {
  for (const text of random(["a", "b", "_", "\\", "&", " ", "."], 11)(300, 14)) {
    expect(through(text)).toBe(text);
  }
});

const inline = (e: ReturnType<typeof editor>) =>
  (
    e.getEditorState().toJSON().root.children[0] as unknown as {
      children: { type: string; path?: string }[];
    }
  ).children;

test("a mention the draft holds reads back as a block, and writes as its @path; one it does not hold stays text", () => {
  const e = editor();
  setMarkdown(e, "see @src/a_b.ts and @other and @Fix the bug.", [
    { path: "src/a_b.ts", kind: "file" },
    { path: "Fix the bug", kind: "session" },
  ]);
  const kinds = e.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map((n) => n.getTextContent()),
  );
  expect(kinds).toEqual(["see ", " and @other and ", "."]);
  expect(
    inline(e)
      .filter((c) => c.type === "mention")
      .map((c) => c.path),
  ).toEqual(["src/a_b.ts", "Fix the bug"]);
  expect(markdownOf(e)).toBe("see @src/a_b.ts and @other and @Fix the bug.");
});

test("a folder's block says the slash, and no list means no block", () => {
  const e = editor();
  setMarkdown(e, "in @src/ now", [{ path: "src", kind: "folder" }]);
  expect(markdownOf(e)).toBe("in @src/ now");
  expect(inline(e).map((c) => c.type)).toContain("mention");
  const plain = editor();
  setMarkdown(plain, "in @src/ now");
  expect(JSON.stringify(plain.getEditorState().toJSON())).not.toContain("mention");
});

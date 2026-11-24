import { expect, test } from "bun:test";
import {
  type Draft,
  DraftStore,
  draftOf,
  fileUri,
  type Mention,
  mentionText,
  NOT_RECALLING,
  promptBlocks,
  recall,
  returnedId,
  sentTexts,
  wordAt,
} from "../src/draft.ts";
import type { Block } from "../src/model/index.ts";

/** A storage that is only a map, and can be told to fail. */
const memory = (fail = false) => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => {
      if (fail) throw new Error("denied");
      return items.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("full");
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
};

const image = {
  id: "i",
  name: "a.png",
  kind: "image" as const,
  type: "image/png" as const,
  data: "AAAA",
  bytes: 3,
};

test("an attached text file and PDF go as embedded resources under their names, and come back as attachments", () => {
  const notes = {
    id: "n",
    name: "notes v2.md",
    kind: "text" as const,
    type: "text/markdown",
    data: "<b>hi</b>",
    bytes: 9,
  };
  const pdf = {
    id: "p",
    name: "spec.pdf",
    kind: "pdf" as const,
    type: "application/pdf",
    data: "AAAA",
    bytes: 3,
  };
  const sent = promptBlocks({
    text: "read",
    attachments: [image, notes, pdf],
    mentions: [],
    kept: [],
  });
  expect(sent).toEqual([
    { type: "text", text: "read" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    {
      type: "resource",
      resource: {
        uri: "attachment:///notes%20v2.md",
        mimeType: "text/markdown",
        text: "<b>hi</b>",
      },
    },
    {
      type: "resource",
      resource: { uri: "attachment:///spec.pdf", mimeType: "application/pdf", blob: "AAAA" },
    },
  ]);
  const back = draftOf((sent ?? []) as Block[]);
  expect(back.kept).toEqual([]);
  expect(back.attachments.map(({ id: _, ...a }) => a)).toEqual([
    // An image block carries no name.
    { name: "image", kind: "image", type: "image/png", data: "AAAA", bytes: 3 },
    { name: "notes v2.md", kind: "text", type: "text/markdown", data: "<b>hi</b>", bytes: 9 },
    { name: "spec.pdf", kind: "pdf", type: "application/pdf", data: "AAAA", bytes: 3 },
  ]);
  expect(promptBlocks(back)).toEqual(sent);
});

test("a draft is kept per session, and the same object until it changes", () => {
  const drafts = new DraftStore(undefined);
  // A session with nothing written has the one empty draft.
  expect(drafts.get("a")).toBe(drafts.get("b"));
  expect(drafts.get("a").text).toBe("");
  drafts.setText("a", "hello");
  drafts.setText("b", "other");
  expect(drafts.get("a").text).toBe("hello");
  expect(drafts.get("a")).toBe(drafts.get("a"));
  expect(drafts.get("b").text).toBe("other");
});

test("sending clears the draft, and an image still being read for it is told it is too late", () => {
  const drafts = new DraftStore(undefined);
  drafts.setText("a", "send me");
  const reading = drafts.generation("a");
  drafts.clear("a");
  expect(drafts.get("a").text).toBe("");
  expect(drafts.generation("a")).not.toBe(reading);
  // Another session's reading is not affected.
  expect(drafts.generation("b")).toBe(0);
});

test("a deleted session, and a removed host, lose their drafts, in memory and in storage", () => {
  const storage = memory();
  const drafts = new DraftStore(storage);
  drafts.setText("h1:a", "1");
  drafts.setText("h1:b", "2");
  drafts.setText("h2:a", "3");
  drafts.forget("h1:a");
  expect(drafts.get("h1:a").text).toBe("");
  drafts.forgetLocation("h1");
  expect(drafts.get("h1:b").text).toBe("");
  expect(drafts.get("h2:a").text).toBe("3");
  expect([...storage.items.keys()]).toEqual(["cycle:draft:h2:a"]);
  // A page that starts later finds only the other location's.
  const later = new DraftStore(storage);
  expect(later.get("h1:b").text).toBe("");
  expect(later.get("h2:a").text).toBe("3");
});

test("a host's drafts that this page never read are removed from storage too", () => {
  const storage = memory();
  storage.setItem("cycle:draft:h1:old", JSON.stringify({ text: "from before" }));
  storage.setItem("cycle:draft:h10:old", JSON.stringify({ text: "another host" }));
  const drafts = new DraftStore(storage);
  drafts.forgetLocation("h1");
  expect([...storage.items.keys()]).toEqual(["cycle:draft:h10:old"]);
  expect(drafts.get("h1:old").text).toBe("");
});

test("a deleted session or removed host tells a read in flight it is too late, though nothing was ever sent", () => {
  const drafts = new DraftStore(undefined);
  const reading = drafts.generation("h1:a");
  drafts.forget("h1:a");
  expect(drafts.generation("h1:a")).not.toBe(reading);
  const other = drafts.generation("h1:b");
  const elsewhere = drafts.generation("h2:a");
  drafts.forgetLocation("h1");
  expect(drafts.generation("h1:b")).not.toBe(other);
  expect(drafts.generation("h2:a")).toBe(elsewhere);
});

test("the text outlasts a restart, and the images do not", () => {
  const storage = memory();
  const first = new DraftStore(storage);
  first.setText("local:s1", "half a thought");
  first.setAttachments("local:s1", [image]);
  const second = new DraftStore(storage);
  expect(second.get("local:s1")).toEqual({
    text: "half a thought",
    attachments: [],
    mentions: [],
    kept: [],
  });
  // No base64 went into the storage.
  expect([...storage.items.values()].join("")).not.toContain("AAAA");
});

test("sent or forgotten, nothing is left in the storage", () => {
  const storage = memory();
  const drafts = new DraftStore(storage);
  drafts.setText("k", "x");
  expect(storage.items.size).toBe(1);
  drafts.clear("k");
  expect(storage.items.size).toBe(0);
  drafts.setText("k", "y");
  drafts.markHandled("k", "id");
  drafts.clear("k");
  // What was handed back is still remembered, so it is not put in the box again.
  expect(drafts.handled("k", "id")).toBe(true);
  drafts.forget("k");
  expect(storage.items.size).toBe(0);
  expect(drafts.handled("k", "id")).toBe(false);
});

test("a storage that fails, or holds nonsense, does not break the draft", () => {
  const broken = new DraftStore(memory(true));
  broken.setText("k", "still here");
  expect(broken.get("k").text).toBe("still here");
  const nonsense = memory();
  nonsense.items.set("cycle:draft:k", "{not json");
  expect(new DraftStore(nonsense).get("k").text).toBe("");
});

test("subscribers hear of a change, and of nothing else", () => {
  const drafts = new DraftStore(undefined);
  let heard = 0;
  const stop = drafts.subscribe(() => heard++);
  drafts.setText("k", "a");
  drafts.setText("k", "a");
  expect(heard).toBe(1);
  stop();
  drafts.setText("k", "b");
  expect(heard).toBe(1);
});

test("what comes back goes in front of what was written since, as older words come first", () => {
  const drafts = new DraftStore(undefined);
  drafts.setText("k", "newer");
  drafts.setAttachments("k", [image]);
  drafts.restore("k", [
    [{ type: "text", text: "one" }],
    [
      { type: "text", text: "two" },
      { type: "image", data: "BBBB", mimeType: "image/png" },
      { type: "resource_link", name: "x", uri: "file:///x" },
    ],
  ]);
  const draft = drafts.get("k");
  expect(draft.text).toBe("one\n\ntwo\n\nnewer");
  expect(draft.attachments.map((a) => a.data)).toEqual(["BBBB", "AAAA"]);
});

test("a prompt's blocks become a draft, and a draft becomes blocks, text first", () => {
  const back = draftOf([
    { type: "text", text: "look" },
    { type: "image", data: "AAAA", mimeType: "image/gif" },
    { type: "image", data: "AAAA", mimeType: "image/svg+xml" },
  ]);
  expect(back.text).toBe("look");
  expect(back.attachments.map((a) => a.type)).toEqual(["image/gif"]);
  // The picture the box cannot show is not dropped: it is kept, and goes out as it was.
  expect(promptBlocks(back)).toEqual([
    { type: "text", text: "look" },
    { type: "image", data: "AAAA", mimeType: "image/gif" },
    { type: "image", data: "AAAA", mimeType: "image/svg+xml" },
  ]);
  expect(
    promptBlocks({ text: "  \n", attachments: [], mentions: [], kept: [] } satisfies Draft),
  ).toBeUndefined();
  expect(promptBlocks({ text: " ", attachments: [image], mentions: [], kept: [] })).toEqual([
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
});

test("a hand-back has the id of what was in it", () => {
  expect(
    returnedId([
      { queueId: "a", prompt: [] },
      { queueId: "b", prompt: [] },
    ]),
  ).toBe("a|b");
});

test("up walks back through what was sent, and down returns to an empty box", () => {
  const sent = ["first", "second", "third"];
  const up1 = recall(sent, NOT_RECALLING, "", "up");
  expect(up1?.text).toBe("third");
  const up2 = recall(sent, up1?.state ?? NOT_RECALLING, "third", "up");
  expect(up2?.text).toBe("second");
  const up3 = recall(sent, up2?.state ?? NOT_RECALLING, "second", "up");
  const up4 = recall(sent, up3?.state ?? NOT_RECALLING, "first", "up");
  // Nothing before the first: the key is the caret's.
  expect(up4).toBeUndefined();
  const down = recall(sent, up2?.state ?? NOT_RECALLING, "second", "down");
  expect(down?.text).toBe("third");
  expect(recall(sent, down?.state ?? NOT_RECALLING, "third", "down")).toEqual({
    text: "",
    state: NOT_RECALLING,
  });
});

test("the arrows are the caret's in text that is being written", () => {
  const sent = ["old"];
  expect(recall(sent, NOT_RECALLING, "typing", "up")).toBeUndefined();
  expect(recall(sent, NOT_RECALLING, "", "down")).toBeUndefined();
  // Recalled, then edited: it is the person's text now, not a recalled one.
  const up = recall(sent, NOT_RECALLING, "", "up");
  expect(recall(sent, up?.state ?? NOT_RECALLING, "old, and more", "up")).toBeUndefined();
  expect(recall([], NOT_RECALLING, "", "up")).toBeUndefined();
});

test("what was sent is read from the conversation: the person's messages with words in them", () => {
  expect(
    sentTexts([
      { kind: "user", blocks: [{ type: "text", text: "a" }] },
      { kind: "agent", blocks: [{ type: "text", text: "no" }] },
      { kind: "user", blocks: [{ type: "image", data: "AAAA" }] },
      { kind: "user", blocks: [{ type: "text", text: "b" }] },
    ]),
  ).toEqual(["a", "b"]);
});

const file = (path: string, root = "/work"): Mention => ({
  path,
  kind: "file",
  uri: fileUri(root, path, "file"),
  name: path.slice(path.lastIndexOf("/") + 1),
});
const folder = (path: string, root = "/work"): Mention => ({
  path,
  kind: "folder",
  uri: fileUri(root, path, "folder"),
  name: path.slice(path.lastIndexOf("/") + 1),
});

test("a mention is the readable @path in the text, and a link beside it for the agent", () => {
  const draft: Draft = {
    text: "look at @src/main.ts and @docs/ please",
    attachments: [],
    mentions: [file("src/main.ts"), folder("docs")],
    kept: [],
  };
  expect(promptBlocks(draft)).toEqual([
    { type: "text", text: "look at @src/main.ts and @docs/ please" },
    {
      type: "resource_link",
      name: "main.ts",
      uri: "file:///work/src/main.ts",
      _meta: { "cycle/mention": "src/main.ts" },
    },
    {
      type: "resource_link",
      name: "docs",
      uri: "file:///work/docs/",
      _meta: { "cycle/mention": "docs" },
    },
  ]);
});

test("a mention the words no longer say is not sent, and one picked twice is sent once", () => {
  const draft: Draft = {
    text: "only @a.ts remains",
    attachments: [],
    mentions: [file("a.ts"), file("b.ts"), file("a.ts")],
    kept: [],
  };
  const links = (promptBlocks(draft) ?? []).filter((b) => b.type === "resource_link");
  expect(links.map((b) => (b as { name: string }).name)).toEqual(["a.ts"]);
  const store = new DraftStore(undefined);
  store.addMention("k", file("a.ts"));
  store.addMention("k", file("a.ts"));
  expect(store.get("k").mentions).toHaveLength(1);
});

test("a mention is sent for the whole word the text says, not for a longer name it is the start of", () => {
  const sent = (text: string) =>
    (promptBlocks({ text, attachments: [], mentions: [file("a.ts")], kept: [] }) ?? []).filter(
      (b) => b.type === "resource_link",
    ).length;
  expect(sent("see @a.tsx")).toBe(0);
  expect(sent("see @a.tsconfig")).toBe(0);
  expect(sent("mail@a.ts")).toBe(0);
  expect(sent("see @a.ts")).toBe(1);
  expect(sent("see @a.ts.")).toBe(1);
  expect(sent("(@a.ts), and @a.ts: yes")).toBe(1);
  expect(sent("@a.ts\nnext line")).toBe(1);
});

test("links share the block limit with the images: the words say it all when there is no room", () => {
  const mentions = Array.from({ length: 40 }, (_, i) => file(`f${i}.ts`));
  const text = mentions.map(mentionText).join(" ");
  const blocks = promptBlocks({ text, attachments: [image], mentions, kept: [] }) ?? [];
  expect(blocks).toHaveLength(32);
  expect(blocks[0]).toEqual({ type: "text", text });
});

test("an address is made of the root and the path, each part kept apart from the others' characters", () => {
  expect(fileUri("/work", "src/a b.ts", "file")).toBe("file:///work/src/a%20b.ts");
  expect(fileUri("/work/", "dir (1)/x#1?.ts", "file")).toBe("file:///work/dir%20(1)/x%231%3F.ts");
  expect(fileUri("/home/u", "lib", "folder")).toBe("file:///home/u/lib/");
});

test("a link that comes back is a mention again", () => {
  const sent = promptBlocks({
    text: "see @src/main.ts",
    attachments: [],
    mentions: [file("src/main.ts")],
    kept: [],
  });
  const back = draftOf(sent ?? []);
  expect(back.text).toBe("see @src/main.ts");
  expect(back.mentions).toEqual([file("src/main.ts")]);
  expect(draftOf([{ type: "resource_link", name: "x", uri: "file:///x" }]).mentions).toEqual([]);
});

test("blocks the box cannot edit come back whole: a PDF, a text file, a link that was not a mention", () => {
  const sent: Block[] = [
    { type: "text", text: "read these" },
    { type: "resource", resource: { uri: "file:///work/notes.txt", text: "hello" } },
    {
      type: "resource",
      resource: { uri: "file:///work/spec.pdf", mimeType: "application/pdf", blob: "AAAA" },
    },
    { type: "resource_link", name: "docs", uri: "https://docs.example/x" },
  ];
  const back = draftOf(sent);
  expect(back.text).toBe("read these");
  expect(back.kept.map((k) => k.name)).toEqual(["notes.txt", "spec.pdf", "docs"]);
  expect(promptBlocks(back)).toEqual(sent as never);
  // Through the store, with what was written since in front or behind, as for any hand-back.
  const store = new DraftStore(undefined);
  store.setText("k", "and");
  store.restore("k", [sent]);
  expect(store.get("k").kept).toHaveLength(3);
  expect(promptBlocks(store.get("k"))).toEqual([
    { type: "text", text: "read these\n\nand" },
    ...(sent.slice(1) as never[]),
  ]);
  // A person can take one out, and then it is not sent.
  const first = store.get("k").kept[0];
  store.removeKept("k", first?.id ?? "");
  expect(promptBlocks(store.get("k"))?.length).toBe(3);
  // Nothing but a kept block is still something to send.
  expect(promptBlocks({ text: "", attachments: [], mentions: [], kept: back.kept })).toHaveLength(
    3,
  );
});

test("a session named with @ is its title in the text and a session link beside it, and comes back as a mention", () => {
  const mention: Mention = {
    path: "Fix the login bug",
    kind: "session",
    uri: "cycle://session/s2",
    name: "Fix the login bug",
  };
  expect(mentionText(mention)).toBe("@Fix the login bug");
  const sent = promptBlocks({
    text: "go on from @Fix the login bug.",
    attachments: [],
    mentions: [mention],
    kept: [],
  });
  expect(sent).toEqual([
    { type: "text", text: "go on from @Fix the login bug." },
    {
      type: "resource_link",
      name: "Fix the login bug",
      uri: "cycle://session/s2",
      _meta: { "cycle/mention": "Fix the login bug" },
    },
  ]);
  expect(draftOf((sent ?? []) as Block[]).mentions).toEqual([mention]);
});

test("an @name is found only as a whole word", () => {
  expect(wordAt("see @Fixtures and @Fix.", "@Fix")).toBe(18);
  expect(wordAt("@Fixtures", "@Fix")).toBe(-1);
  expect(wordAt("(@Fix) then @Fix", "@Fix", 6)).toBe(12);
  expect(wordAt("a@Fix", "@Fix")).toBe(-1);
});

import { expect, test } from "bun:test";
import { FilesViews, foldersOf, insideFolder } from "../src/files-view.ts";
import { fenced } from "../src/react/files.tsx";

test("a path the conversation gives is shown only when it is inside the session's folder", () => {
  expect(insideFolder("/work/src/a.ts", "/work")).toBe("src/a.ts");
  expect(insideFolder("/work/src/a.ts", "/work/")).toBe("src/a.ts");
  expect(insideFolder("file:///work/my%20dir/", "/work")).toBe("my dir");
  expect(insideFolder("/workspace/a.ts", "/work")).toBeUndefined();
  expect(insideFolder("/work", "/work")).toBeUndefined();
  expect(insideFolder("/work/../etc/passwd", "/work")).toBeUndefined();
  expect(insideFolder("relative/a.ts", "/work")).toBeUndefined();
  // A session working at the root.
  expect(insideFolder("/etc/hosts", "/")).toBe("etc/hosts");
});

test("showing a file opens the folders it is in; going back finds the tree as it was", () => {
  expect(foldersOf("a/b/c.ts")).toEqual(["a", "a/b"]);
  const views = new FilesViews();
  let changes = 0;
  views.subscribe(() => {
    changes += 1;
  });
  views.toggle("k", "docs");
  views.show("k", "src/lib/x.ts");
  expect(views.get("k").file).toBe("src/lib/x.ts");
  expect([...views.get("k").expanded].sort()).toEqual(["docs", "src", "src/lib"]);
  views.back("k");
  expect(views.get("k").file).toBeUndefined();
  views.toggle("k", "docs");
  expect(views.get("k").expanded.has("docs")).toBe(false);
  views.reveal("k", "a/b");
  expect([...views.get("k").expanded]).toEqual(expect.arrayContaining(["a", "a/b"]));
  expect(changes).toBe(5);
  views.forget("k");
  expect(views.get("other")).toBe(views.get("k"));
});

test("lines asked for are a request: each asks again, and once gone to they are let go", () => {
  const views = new FilesViews();
  views.show("k", "a.ts", { line: 12, end: 20 });
  const first = views.get("k").lines;
  expect(first).toMatchObject({ start: 12, end: 20 });
  // The same lines again, the file already shown: a new request.
  views.show("k", "a.ts", { line: 12, end: 20 });
  const second = views.get("k").lines;
  expect(second?.serial).not.toBe(first?.serial);
  // An older request gone to lets go of nothing; the current one is let go.
  views.landed("k", first?.serial ?? 0);
  expect(views.get("k").lines).toBe(second);
  views.landed("k", second?.serial ?? 0);
  expect(views.get("k").lines).toBeUndefined();
  expect(views.get("k").file).toBe("a.ts");
  // One line, a range that ends before it starts, and a file shown without lines.
  views.show("k", "a.ts", { line: 5, end: 2 });
  expect(views.get("k").lines).toMatchObject({ start: 5, end: 5 });
  views.show("k", "b.ts");
  expect(views.get("k").lines).toBeUndefined();
  views.show("k", "a.ts", { line: 5 });
  views.back("k");
  expect(views.get("k").lines).toBeUndefined();
});

test("a file's text is fenced past any run of backticks in it", () => {
  expect(fenced("let x = 1;", "ts")).toBe("```ts\nlet x = 1;\n```");
  expect(fenced("a ```` b\n", "md")).toBe("`````md\na ```` b\n`````");
});

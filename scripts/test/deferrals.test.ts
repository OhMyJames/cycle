import { expect, test } from "bun:test";
import { checkDeferrals } from "../lib/deferrals.ts";

test.each([
  [
    "a shortcut with its trigger",
    "// shortcut: reads the whole file; upgrade when logs pass 10 MB\nf();",
  ],
  [
    "a shortcut that wraps",
    "// shortcut: one daemon only;\n// upgrade once a second owner signs in\nf();",
  ],
  [
    "a shortcut in a doc comment",
    "/**\n * Reads it.\n * shortcut: no retry; upgrade if the gateway drops calls\n */\nf();",
  ],
  ["a marker inside a string", 'const s = "// TODO later";'],
  ["a marker inside a template", "const s = `// FIXME ${a /* fine */} // HACK`;"],
  ["a marker inside a regular expression", "const r = /\\/\\/ TODO|[/*] XXX/;"],
  ["a marker as an identifier", "const TODO = 1; f(TODO);"],
  ["prose about a keyboard shortcut", "// The keyboard shortcut: Cmd+K opens it.\nf();"],
])("passes %s", (_name, code) => {
  expect(checkDeferrals(code)).toEqual([]);
});

test.each([
  ["a TODO", "f();\n// TODO: retry\nf();", "line 2: write TODO"],
  ["a FIXME in a block", "/* FIXME races */ f();", "line 1: write FIXME"],
  ["an XXX after code", "const a = b / c; // XXX\n", "line 1: write XXX"],
  ["a HACK inside a substitution", "const s = `${a /* HACK */}`;", "line 1: write HACK"],
  ["a marker after a string", 'const s = "it\'s"; // TODO\n', "line 1: write TODO"],
  [
    "a shortcut without a trigger",
    "// shortcut: reads the whole file\nf();",
    "line 1: a shortcut names when",
  ],
  [
    "a trigger in a later, separate comment",
    "// shortcut: reads the whole file\nf();\n// upgrade when logs grow\n",
    "line 1: a shortcut names when",
  ],
])("fails on %s", (_name, code, start) => {
  const messages = checkDeferrals(code);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toStartWith(start);
});

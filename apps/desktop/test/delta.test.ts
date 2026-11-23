import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { assembleDelta, DeltaDeclined, packBundle, scanBundle } from "../src/main/delta.ts";
import { makeZip, type Spec, writeBundle, type ZipOptions } from "./zip-fixture.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-delta-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Some text that does not compress to nothing, so a file has a size worth fetching. */
const noise = (seed: number, length: number) => {
  let x = seed;
  let out = "";
  while (out.length < length) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += x.toString(36);
  }
  return out.slice(0, length);
};

// Larger than the gap across which neighbouring requests are merged, so that it is never fetched by the way.
const BIG = noise(1, 200_000);
const OLD: Spec = {
  "Contents/Info.plist": "version 1",
  "Contents/MacOS/Electron": { text: "#!electron", mode: 0o755 },
  "Contents/Frameworks/Lib/Versions/A/Lib": BIG,
  "Contents/Frameworks/Lib/Versions/Current": { link: "A" },
  "Contents/Frameworks/Lib/Lib": { link: "Versions/Current/Lib" },
  "Contents/Resources/app/main.js": "old main",
  "Contents/Resources/app/gone.txt": "only in the old one",
};
const NEW: Spec = {
  ...OLD,
  "Contents/Info.plist": "version 2",
  "Contents/Resources/app/main.js": "new main, a little longer",
  "Contents/Resources/app/added.txt": "only in the new one",
};
delete NEW["Contents/Resources/app/gone.txt"];

type Server = {
  get: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;
  /** The signal each request was given. */
  signals: AbortSignal[];
  /** The ranges asked for, and how many bytes they cover. */
  asked: [number, number][];
  served: () => number;
};
/** A server for an archive: it answers ranges, unless asked to ignore them or to lie about them. */
const serve = (zip: Uint8Array, mode: "ranges" | "ignores" | "lies" = "ranges"): Server => {
  const asked: [number, number][] = [];
  const signals: AbortSignal[] = [];
  return {
    asked,
    signals,
    served: () => asked.reduce((sum, [a, b]) => sum + (b - a + 1), 0),
    get: async (_url, headers, signal) => {
      signals.push(signal);
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
      if (match === null || mode === "ignores") return new Response(Buffer.from(zip));
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), zip.length - 1);
      asked.push([start, end]);
      const shift = mode === "lies" ? 1 : 0;
      return new Response(Buffer.from(zip.subarray(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start + shift}-${end}/${zip.length}` },
      });
    },
  };
};

const prepare = async (newSpec: Spec, oldSpec: Spec = OLD, options: ZipOptions = {}) => {
  const installed = join(dir, "installed");
  const fresh = join(dir, "fresh");
  await writeBundle(installed, oldSpec);
  await writeBundle(fresh, newSpec);
  const tree = await scanBundle(fresh);
  const zip = makeZip(newSpec, options);
  return { installed, tree, zip, fresh };
};

const run = (
  made: { installed: string; tree: Awaited<ReturnType<typeof scanBundle>>; zip: Uint8Array },
  server: Server,
  plans: number[] = [],
) =>
  assembleDelta({
    installed: made.installed,
    into: join(dir, "into"),
    archiveUrl: "https://example.test/Cycle.zip",
    archiveSize: made.zip.length,
    tree: made.tree,
    get: server.get,
    onPlan: (total) => plans.push(total),
    onProgress: () => {},
  });

test("it assembles the new bundle from the installed files and only the files that changed", async () => {
  const made = await prepare(NEW);
  const server = serve(made.zip);
  const plans: number[] = [];
  const done = await run(made, server, plans);

  // Exactly the bundle the table describes: files, modes, links, and nothing else.
  expect(await scanBundle(done.app)).toEqual(made.tree);
  expect(await readFile(join(done.app, "Contents/Resources/app/main.js"), "utf8")).toBe(
    "new main, a little longer",
  );
  expect(await readlink(join(done.app, "Contents/Frameworks/Lib/Lib"))).toBe(
    "Versions/Current/Lib",
  );
  expect((await lstat(join(done.app, "Contents/MacOS/Electron"))).mode & 0o777).toBe(0o755);
  // Three files were not in the installed bundle as they are now; the big one and the executable were taken from it.
  expect(done.changed).toBe(3);
  expect(done.reused).toBe(2);
  expect(plans).toEqual([done.fetched]);
  // (The first request is for the archive's end, which in an archive this small is all of it.)
  expect(done.fetched).toBeLessThan(made.zip.length / 4);
  expect(server.served()).toBe(made.zip.length + done.fetched);
});

test("a file that is the same size but not the same bytes is fetched, not taken", async () => {
  const made = await prepare(NEW, { ...OLD, "Contents/Info.plist": "version 9" });
  const done = await run(made, serve(made.zip));
  expect(await readFile(join(done.app, "Contents/Info.plist"), "utf8")).toBe("version 2");
  expect(await scanBundle(done.app)).toEqual(made.tree);
});

test("a link in the installed bundle is never taken for the file it stands where", async () => {
  const outside = join(dir, "secret.txt");
  await writeFile(outside, "not part of the app");
  const made = await prepare(NEW);
  // Same size as the new Info.plist, and a link to a file of exactly that content.
  await rm(join(made.installed, "Contents/Info.plist"));
  await writeFile(outside, "version 2");
  await symlink(outside, join(made.installed, "Contents/Info.plist"));
  const done = await run(made, serve(made.zip));
  expect((await lstat(join(done.app, "Contents/Info.plist"))).isFile()).toBe(true);
  expect(await scanBundle(done.app)).toEqual(made.tree);
});

test("local headers with extra fields, and files that are stored, are read the same", async () => {
  const made = await prepare(NEW, OLD, {
    localExtra: 28,
    stored: ["Contents/Resources/app/main.js", "Contents/Info.plist"],
  });
  const done = await run(made, serve(made.zip));
  expect(await scanBundle(done.app)).toEqual(made.tree);
});

test("a server that ignores the range is not read: the answer is refused before its body is", async () => {
  const made = await prepare(NEW);
  await expect(run(made, serve(made.zip, "ignores"))).rejects.toThrow(/range/);
});

test("a range that is not the one asked for is refused", async () => {
  const made = await prepare(NEW);
  await expect(run(made, serve(made.zip, "lies"))).rejects.toThrow(/not the one asked for/);
});

test("bytes in the archive that are not the file the table names are refused", async () => {
  const bad = new TextEncoder().encode("x".repeat(25));
  const made = await prepare(NEW, OLD, {
    stored: ["Contents/Resources/app/main.js"],
    corrupt: { "Contents/Resources/app/main.js": bad },
  });
  await expect(run(made, serve(made.zip))).rejects.toThrow(/does not match|larger than/);
});

test("an archive whose directory gives another size than the table is refused", async () => {
  const made = await prepare(NEW, OLD, { claimedSize: { "Contents/Info.plist": 99 } });
  await expect(run(made, serve(made.zip))).rejects.toThrow(/not the size/);
});

test("a file the archive does not have is refused", async () => {
  const made = await prepare(NEW);
  const without = { ...NEW };
  delete without["Contents/Resources/app/added.txt"];
  await expect(run({ ...made, zip: makeZip(without) }, serve(makeZip(without)))).rejects.toThrow(
    /has no Contents\/Resources\/app\/added.txt/,
  );
});

test("when nearly everything changed it is declined, and nothing was fetched but the directory", async () => {
  const everything: Spec = {};
  for (const path of Object.keys(OLD)) everything[path] = noise(path.length, 5_000);
  const made = await prepare(everything);
  const server = serve(made.zip);
  await expect(run(made, server)).rejects.toBeInstanceOf(DeltaDeclined);
  expect(server.asked.length).toBe(1);
});

test("the requests are stopped when one part fails, and not before", async () => {
  const good = await prepare(NEW);
  const quiet = serve(good.zip);
  await run(good, quiet);
  expect(quiet.signals.length).toBeGreaterThan(0);
  expect(quiet.signals.every((signal) => !signal.aborted)).toBe(true);

  for (const name of ["into", "installed", "fresh"])
    await rm(join(dir, name), { recursive: true, force: true });
  const bad = await prepare(NEW, OLD, {
    stored: ["Contents/Resources/app/main.js"],
    corrupt: { "Contents/Resources/app/main.js": new TextEncoder().encode("main of 0.2.X") },
  });
  const loud = serve(bad.zip);
  await expect(run(bad, loud)).rejects.toThrow(/does not match/);
  expect(loud.signals.every((signal) => signal.aborted)).toBe(true);
});

test.skipIf(process.getuid?.() === 0)(
  "an installed file that cannot be read is fetched like one that changed, not a reason to give up",
  async () => {
    const made = await prepare(NEW);
    await chmod(join(made.installed, "Contents/MacOS/Electron"), 0o000);
    const done = await run(made, serve(made.zip));
    expect(done.changed).toBe(4);
    expect(await scanBundle(done.app)).toEqual(made.tree);
  },
);

// By blocks: the big file is 200 000 bytes, four blocks of 64 KiB (the last one short).
const BLOCK = 1 << 16;
const LIB = "Contents/Frameworks/Lib/Versions/A/Lib";
/** As a binary is on a new release: the same code, a new signature at its end. */
const RESIGNED: Spec = { ...NEW, [LIB]: `${BIG.slice(0, -100)}${noise(7, 100)}` };

/** The archive and the block pack of the new bundle, each at its own address, answering ranges. */
const servePacked = async (made: Awaited<ReturnType<typeof prepare>>, damage = false) => {
  const packPath = join(dir, "new.blocks");
  const pack = await packBundle(made.fresh, made.tree, packPath, BLOCK);
  const packBytes = new Uint8Array(await readFile(packPath));
  if (damage) {
    // The deflated last block of the big file, as other bytes that unpack fine: a block that lies.
    const last = pack.files[LIB]?.at(-1);
    if (last === undefined) throw new Error("no block");
    const forged = deflateRawSync(Buffer.from(noise(9, 200_000 - 3 * BLOCK)));
    const bytes = new Uint8Array(packBytes.length - last.csize + forged.length);
    bytes.set(packBytes.subarray(0, last.offset));
    bytes.set(forged, last.offset);
    const files = {
      ...pack.files,
      [LIB]: [...(pack.files[LIB] ?? []).slice(0, -1), { ...last, csize: forged.length }],
    };
    return withPack(made, { ...pack, size: bytes.length, files }, bytes);
  }
  return withPack(made, pack, packBytes);
};

const withPack = (
  made: Awaited<ReturnType<typeof prepare>>,
  pack: Awaited<ReturnType<typeof packBundle>>,
  bytes: Uint8Array,
) => {
  const archive = serve(made.zip);
  const blocks = serve(bytes);
  const get: Server["get"] = (url, headers, signal) =>
    (url.endsWith(".blocks") ? blocks : archive).get(url, headers, signal);
  const options = {
    installed: made.installed,
    into: join(dir, "into"),
    archiveUrl: "https://example.test/Cycle.zip",
    archiveSize: made.zip.length,
    tree: made.tree,
    pack: { ...pack, file: "Cycle.blocks", url: "https://example.test/Cycle.blocks" },
    get,
    onPlan: () => {},
    onProgress: () => {},
  };
  return { archive, blocks, options };
};

test("a big file that changed only at its end is made from its own blocks and the one block that changed", async () => {
  const made = await prepare(RESIGNED);
  const { blocks, options } = await servePacked(made);
  const done = await assembleDelta(options);
  expect(await scanBundle(done.app)).toEqual(made.tree);
  expect(await readFile(join(done.app, LIB), "utf8")).toBe(RESIGNED[LIB] as string);
  expect(done.byBlocks).toBe(1);
  expect(done.blocksReused).toBe(3);
  // One request to the pack, for the last block only.
  expect(blocks.asked.length).toBe(1);
  expect(blocks.served()).toBeLessThan(BLOCK);
});

test("a block from the pack that is not the block its SHA-256 names is refused", async () => {
  const made = await prepare(RESIGNED);
  const { options } = await servePacked(made, true);
  await expect(assembleDelta(options)).rejects.toThrow(/does not match the block pack/);
});

test("a big file with no block in common with the installed one is fetched whole from the archive", async () => {
  const made = await prepare({ ...NEW, "Contents/Resources/app/bin/tool": noise(11, 70_000) });
  const { blocks, options } = await servePacked(made);
  const done = await assembleDelta(options);
  expect(await scanBundle(done.app)).toEqual(made.tree);
  expect(done.byBlocks).toBe(0);
  expect(blocks.asked.length).toBe(0);
});

test("an installed file that changed under the copy fails the whole file, not silently", async () => {
  const made = await prepare(RESIGNED);
  const { options } = await servePacked(made);
  // Same blocks as it was hashed, then the installed file is cut short before its blocks are copied: the hash of
  // the whole file catches what the per-block plan could not.
  const original = options.get;
  let cut = false;
  options.get = async (url, headers, signal) => {
    if (!cut) {
      cut = true;
      await writeFile(join(made.installed, LIB), BIG.slice(0, BLOCK));
    }
    return original(url, headers, signal);
  };
  await expect(assembleDelta(options)).rejects.toThrow(/does not match the file table/);
});

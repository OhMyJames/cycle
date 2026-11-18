import { expect, test } from "bun:test";
import { setup, worktreeAt } from "./worktree-hub.ts";

const FOLDER = "/repo/.agents/worktree/feature-2";
const stored = { repo: "/repo", base: "abc123", branch: "feature-2", path: FOLDER } as const;

test("a user says what the list shows of it: title, preview, archived, and the record's base and origin", async () => {
  const { harness, hub } = await setup({
    sessions: { kept: { worktree: { ...stored, origin: "agent" } } },
  });
  harness.stored = [
    harness.session("kept", {
      cwd: "/project",
      title: "Old work",
      preview: "first words",
    }),
  ];
  await hub.list(true);
  expect(hub.worktreeUsers(FOLDER)).toEqual([
    {
      id: "kept",
      name: "Old work",
      title: "Old work",
      preview: "first words",
      activity: "idle",
      named: true,
      archived: true,
      base: "abc123",
      origin: "agent",
    },
  ]);
});

test("a session known only by its record has the id for a name, and a record without an origin is the owner's", async () => {
  const { hub } = await setup({ sessions: { unlisted: { worktree: stored } } });
  expect(hub.worktreeUsers(FOLDER)).toEqual([
    {
      id: "unlisted",
      name: "unlisted",
      title: null,
      preview: "",
      activity: "idle",
      named: true,
      archived: false,
      base: "abc123",
      origin: "owner",
    },
  ]);
});

test("a session only in the folder has no base or origin of this worktree", async () => {
  const { harness, hub } = await setup();
  harness.stored = [harness.session("inside", { cwd: `${FOLDER}/pkg` })];
  await hub.list(true);
  expect(hub.worktreeUsers(FOLDER)).toMatchObject([
    { id: "inside", named: false, archived: true, base: null, origin: null },
  ]);
});

test("a worktree of the session is the one it names", async () => {
  const { hub } = await setup();
  const info = await hub.create(worktreeAt);
  const [user] = hub.worktreeUsers(FOLDER);
  expect(user).toMatchObject({
    id: info.id,
    named: true,
    archived: false,
    base: "abc123",
    origin: "owner",
  });
});

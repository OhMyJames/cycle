import { expect, test } from "bun:test";
import type { AccountInfo, SlashCommand } from "@cycle/protocol";
import { accountDetails, accountTitle, limitText } from "../src/lib/account.ts";
import {
  acceptOf,
  attachLabel,
  attachmentKind,
  givenBack,
  keepAccepted,
  matchCommands,
} from "../src/lib/attach.ts";

test("a file is attached as the kind the agent takes, or not at all", () => {
  const all = ["image", "pdf", "text"] as const;
  expect(attachmentKind({ type: "image/png", name: "a.png" }, all)).toBe("image");
  expect(attachmentKind({ type: "application/pdf", name: "a.pdf" }, all)).toBe("pdf");
  expect(attachmentKind({ type: "", name: "notes.md" }, all)).toBe("text");
  expect(attachmentKind({ type: "text/plain", name: "a.txt" }, ["image"])).toBeNull();
  expect(attachmentKind({ type: "application/zip", name: "a.zip" }, all)).toBeNull();
});

test("the chooser asks for what the agent takes", () => {
  expect(acceptOf(["image"])).toBe("image/*");
  expect(acceptOf(["image", "pdf"])).toBe("image/*,application/pdf,.pdf");
  expect(attachLabel(["image"])).toBe("Attach images");
  expect(attachLabel(["image", "text"])).toBe("Attach files");
});

const command = (name: string, patch: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: "",
  argumentHint: "",
  aliases: [],
  builtin: false,
  ...patch,
});

test("commands that start with the query come first, then those holding it, then aliases", () => {
  const list = [
    command("recompact"),
    command("compact", { builtin: true }),
    command("usage", { aliases: ["cost"] }),
    command("compact"),
  ];
  expect(matchCommands(list, "comp").map((each) => each.name)).toEqual(["compact", "recompact"]);
  expect(matchCommands(list, "comp")[0]?.builtin).toBe(true);
  expect(matchCommands(list, "cos").map((each) => each.name)).toEqual(["usage"]);
});

const account = (patch: Partial<AccountInfo>): AccountInfo => ({
  harness: "claude",
  kind: "subscription",
  email: null,
  plan: null,
  organization: null,
  provider: null,
  source: null,
  limits: [],
  ...patch,
});

test("an account is told in a line, naming where its credential comes from and nothing more", () => {
  expect(accountTitle(account({ email: "me@example.com" }))).toBe("me@example.com");
  expect(accountTitle(account({ kind: "cloud", provider: "bedrock" }))).toBe("Through bedrock");
  expect(accountDetails(account({ plan: "max", organization: "Acme", source: "claude.ai" }))).toBe(
    "Plan: max · Acme · Credential from claude.ai",
  );
});

test("a limit says how much is used, or only whether it is reached", () => {
  const limit = {
    id: "five_hour",
    name: "5-hour limit",
    windowMinutes: 300,
    resetsAt: null,
    overage: false,
  };
  expect(limitText({ ...limit, usedPercent: 42.4, status: "ok" })).toBe("42% used");
  expect(limitText({ ...limit, usedPercent: null, status: "ok" })).toBe("Within the limit");
  expect(limitText({ ...limit, usedPercent: null, status: "exceeded", overage: true })).toBe(
    "Reached · using overage",
  );
});

test("moving to an agent that takes less keeps what it reads, and names what it does not", () => {
  const pdf = { kind: "pdf" as const, name: "plan.pdf", data: "data:application/pdf;base64,AA==" };
  const notes = { kind: "text" as const, name: "notes.md", data: "data:text/plain;base64,AA==" };
  const attached = { images: ["data:image/png;base64,AA=="], documents: [pdf, notes] };
  expect(keepAccepted(attached, ["image", "pdf", "text"]).dropped).toEqual([]);
  expect(keepAccepted(attached, ["image"])).toEqual({
    images: attached.images,
    documents: [],
    dropped: ["plan.pdf", "notes.md"],
  });
  expect(keepAccepted(attached, ["pdf"])).toMatchObject({ images: [], documents: [pdf] });
  expect(keepAccepted(attached, ["pdf"]).dropped).toEqual(["1 image", "notes.md"]);
});

test("a stopped turn's queue comes back with its images, and the documents this page holds", () => {
  const pdf = { kind: "pdf" as const, name: "plan.pdf", data: "data:application/pdf;base64,AA==" };
  const queue = [
    {
      id: "q1",
      text: "one",
      images: ["img"],
      documents: [{ kind: "pdf" as const, name: "plan.pdf" }],
    },
    { id: "q2", text: "two", images: [], documents: [{ kind: "text" as const, name: "far.md" }] },
  ];
  expect(givenBack(queue, new Map([["q1", [pdf]]]))).toEqual({
    text: "one\n\ntwo",
    images: ["img"],
    documents: [pdf],
    lost: ["far.md"],
  });
});

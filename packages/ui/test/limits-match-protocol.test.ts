import { expect, test } from "bun:test";
import {
  IMAGE_TYPES,
  PROMPT_LIMITS,
  base64Bytes as protocolBase64Bytes,
  sessionIdOfUri as protocolSessionIdOfUri,
  sessionUri as protocolSessionUri,
  SESSION_URI_PREFIX,
} from "@cycle/protocol";
import { ATTACHMENT_LIMITS, base64Bytes, IMAGE_TYPES as uiImageTypes } from "../src/attachments.ts";
import {
  sessionIdOfUri,
  sessionUri,
  SESSION_URI_PREFIX as uiSessionPrefix,
} from "../src/mention.ts";

// The page may not import `@cycle/protocol`, so it keeps a copy of what a prompt may carry, to tell the person before
// anything is sent. These say the two copies are one: a change on one side alone fails here.

test("the page's limits are the daemon's", () => {
  expect(ATTACHMENT_LIMITS).toEqual(PROMPT_LIMITS);
});

test("the page names a session in a mention as the daemon reads it", () => {
  expect(uiSessionPrefix).toBe(SESSION_URI_PREFIX);
  for (const id of ["s1", "a/b c", "日本"]) {
    const uri = sessionUri(id);
    expect(uri).toBe(protocolSessionUri(id));
    expect(sessionIdOfUri(uri)).toBe(protocolSessionIdOfUri(uri));
  }
  for (const bad of ["cycle://session/", "cycle://session/%E0%A4%A", "file:///a", ""]) {
    expect(sessionIdOfUri(bad)).toBe(protocolSessionIdOfUri(bad));
  }
});

test("the page takes the same image types as the daemon", () => {
  expect([...uiImageTypes]).toEqual([...IMAGE_TYPES]);
});

test("both count the bytes of a base64 text alike, with and without padding, and refuse the same texts", () => {
  const texts = [
    "",
    "AAAA",
    "AAA=",
    "AA==",
    "QUJD",
    "QUJDRA==",
    "QUJDREU=",
    "AAA", // not a multiple of four
    "AA=A", // padding in the middle
    "A===",
    "AAAA====",
    "AA\nAA", // not base64
    "AA AA",
    "////",
    "++++",
    "-_-_", // the URL-safe alphabet is not this one
  ];
  for (const text of texts)
    expect([text, base64Bytes(text)]).toEqual([text, protocolBase64Bytes(text)]);
});

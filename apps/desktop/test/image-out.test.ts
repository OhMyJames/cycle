import { expect, test } from "bun:test";
import { imageBytes, imageFileName, isClipboardType } from "../src/main/image-out.ts";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("a picture the page sends is taken only when it is what it says it is", () => {
  expect(imageBytes("image/png", PNG)?.type).toBe("image/png");
  expect(imageBytes("image/jpeg", JPEG)?.bytes[0]).toBe(0xff);
  expect(imageBytes("image/gif", GIF)?.type).toBe("image/gif");
  expect(imageBytes("image/webp", WEBP)?.type).toBe("image/webp");
  // Another type, a lie about the type, not base64, empty, or not a string at all.
  expect(imageBytes("image/svg+xml", b64([0x3c, 0x73, 0x76, 0x67]))).toBeUndefined();
  expect(imageBytes("text/html", PNG)).toBeUndefined();
  // What it is is read from its bytes: a JPEG sent as a PNG is a JPEG.
  expect(imageBytes("image/png", JPEG)?.type).toBe("image/jpeg");
  expect(imageBytes("image/png", b64([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]))).toBeUndefined();
  expect(imageBytes("image/png", "not base64!")).toBeUndefined();
  expect(imageBytes("image/png", "")).toBeUndefined();
  expect(imageBytes("image/png", 42)).toBeUndefined();
  expect(imageBytes(undefined, PNG)).toBeUndefined();
  // Larger than any the page draws.
  expect(imageBytes("image/png", PNG + "A".repeat(20 * 1024 * 1024))).toBeUndefined();
});

test("the clipboard is given a PNG or a JPEG; the page makes the others a PNG first", () => {
  expect(isClipboardType("image/png")).toBe(true);
  expect(isClipboardType("image/jpeg")).toBe(true);
  expect(isClipboardType("image/gif")).toBe(false);
  expect(isClipboardType("image/webp")).toBe(false);
});

test("the save dialog offers the picture's own name, made safe, with its type's extension", () => {
  expect(imageFileName("shot.png", "image/png")).toBe("shot.png");
  expect(imageFileName("Shot.PNG", "image/png")).toBe("Shot.PNG");
  expect(imageFileName("photo.jpeg", "image/jpeg")).toBe("photo.jpg");
  expect(imageFileName("diagram", "image/webp")).toBe("diagram.webp");
  expect(imageFileName("wrong.png", "image/gif")).toBe("wrong.gif");
  // Only the last part of a path: the page names no place to write.
  expect(imageFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
  expect(imageFileName("C:\\Users\\x\\a.png", "image/png")).toBe("a.png");
  // What a name cannot hold, a hidden file's dot, nothing at all.
  expect(imageFileName('a<b>:"c|?*\u0000.png', "image/png")).toBe("abc.png");
  expect(imageFileName(".hidden", "image/png")).toBe("hidden.png");
  expect(imageFileName(" .env", "image/png")).toBe("env.png");
  // Only an image extension is replaced: other dots are part of the name.
  expect(imageFileName("Screenshot at 10.30", "image/png")).toBe("Screenshot at 10.30.png");
  expect(imageFileName("", "image/png")).toBe("image.png");
  expect(imageFileName("   ", "image/jpeg")).toBe("image.jpg");
  expect(imageFileName(undefined, "image/png")).toBe("image.png");
  expect(imageFileName("x".repeat(300), "image/png").length).toBeLessThanOrEqual(124);
});

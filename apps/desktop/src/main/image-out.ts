// A picture the page shows, going out of the app: onto the clipboard, or into a file the person picks (CYCL-212). The page
// sends the base64 it already has; nothing here trusts it. It must say it is one of the types the page draws, decode, be of
// a size the page could have drawn, and start as one of those files starts. What it is is read from its bytes, not from
// the type it was sent with: an agent's JPEG labelled PNG is drawn by the page, so it is copied and saved as the JPEG it is.
// No Electron here, so it is tested on its own.
import { base64Bytes, type ImageType, isImageType, MAX_SHOWN_BASE64 } from "@cycle/ui";

/** The extension a saved picture of each type is given. */
const EXTENSIONS: Record<ImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const startsWith = (bytes: Uint8Array, head: readonly number[], at = 0): boolean =>
  bytes.length >= at + head.length && head.every((byte, i) => bytes[at + i] === byte);

/** Which of the types the bytes are, by how the file begins. */
const sniff = (b: Uint8Array): ImageType | undefined =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? "image/png"
    : startsWith(b, [0xff, 0xd8, 0xff])
      ? "image/jpeg"
      : startsWith(b, [0x47, 0x49, 0x46, 0x38])
        ? "image/gif"
        : startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
          ? "image/webp"
          : undefined;

/** The picture's bytes and what they are, when what the page sent is a picture; otherwise undefined. */
export const imageBytes = (
  type: unknown,
  data: unknown,
): { type: ImageType; bytes: Uint8Array<ArrayBuffer> } | undefined => {
  if (!isImageType(type) || typeof data !== "string" || data.length > MAX_SHOWN_BASE64)
    return undefined;
  if (!base64Bytes(data)) return undefined;
  const bytes = Uint8Array.from(Buffer.from(data, "base64"));
  const actual = sniff(bytes);
  return actual === undefined ? undefined : { type: actual, bytes };
};

/** What the clipboard is given as a picture (a JPEG is made a PNG first). The page makes the others a PNG. */
export const isClipboardType = (type: ImageType): boolean =>
  type === "image/png" || type === "image/jpeg";

/** The extension a saved picture of this type is given. */
export const extensionOf = (type: ImageType): string => EXTENSIONS[type];

/**
 * The name the save dialog offers: the picture's own name when it has one (its last part only, with nothing a file name
 * cannot hold and not hidden), ending in its type's extension (an image extension it had is replaced, any other dot is
 * kept: "at 10.30" is part of a name); else "image".
 */
export const imageFileName = (name: unknown, type: ImageType): string => {
  const ext = EXTENSIONS[type];
  const last = typeof name === "string" ? (name.split(/[/\\]/).at(-1) ?? "") : "";
  const clean = [...last]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && !'<>:"|?*'.includes(c))
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  const stem = clean.replace(/\.(png|jpe?g|gif|webp)$/i, "");
  if (stem === "") return `image.${ext}`;
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${stem}.${ext}`;
};

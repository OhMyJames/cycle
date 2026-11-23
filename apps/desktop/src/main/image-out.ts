// A picture the page shows, going out of the app: onto the clipboard, or into a file the person picks (CYCL-212). The page
// sends the base64 it already has; nothing here trusts it. It must be one of the types the page draws, decode, be of a size
// the page could have drawn, and start as such a file starts. No Electron here, so it is tested on its own.

/** The types the page draws (`IMAGE_TYPES` of @cycle/ui's attachments), and the extension a saved one is given. */
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type OutImageType = keyof typeof EXTENSIONS;

/** The most of base64 the page will draw (`MAX_SHOWN_BASE64`): no picture it shows is larger. */
const MAX_BASE64 = 20 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const startsWith = (bytes: Uint8Array, head: readonly number[], at = 0): boolean =>
  bytes.length >= at + head.length && head.every((byte, i) => bytes[at + i] === byte);

/** How each type's file begins. */
const SIGNED: Record<OutImageType, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  // RIFF....WEBP
  "image/webp": (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
};

const isOutType = (type: unknown): type is OutImageType =>
  typeof type === "string" && Object.hasOwn(EXTENSIONS, type);

/** The picture's bytes, when what the page sent is a picture of the type it says; otherwise undefined. */
export const imageBytes = (
  type: unknown,
  data: unknown,
): { type: OutImageType; bytes: Uint8Array<ArrayBuffer> } | undefined => {
  if (!isOutType(type) || typeof data !== "string") return undefined;
  if (data.length === 0 || data.length > MAX_BASE64 || data.length % 4 !== 0) return undefined;
  if (!BASE64.test(data)) return undefined;
  const bytes = Uint8Array.from(Buffer.from(data, "base64"));
  return SIGNED[type](bytes) ? { type, bytes } : undefined;
};

/** What the clipboard takes as a picture (Electron's `nativeImage` reads these two). The page makes the others a PNG. */
export const isClipboardType = (type: OutImageType): boolean =>
  type === "image/png" || type === "image/jpeg";

/** The extension a saved picture of this type is given. */
export const extensionOf = (type: OutImageType): string => EXTENSIONS[type];

/**
 * The name the save dialog offers: the picture's own name when it has one (its last part only, with nothing a file name
 * cannot hold), ending in its type's extension; else "image".
 */
export const imageFileName = (name: unknown, type: OutImageType): string => {
  const ext = EXTENSIONS[type];
  const last = typeof name === "string" ? (name.split(/[/\\]/).at(-1) ?? "") : "";
  // Control characters and what Windows and macOS refuse in a name go; no leading dots (a hidden file).
  const clean = [...last]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && !'<>:"|?*'.includes(c))
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (clean.toLowerCase().endsWith(`.${ext}`) && clean.length > ext.length + 1) return clean;
  const stem = clean.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return `${stem === "" ? "image" : stem}.${ext}`;
};

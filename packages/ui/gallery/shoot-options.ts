// Options of shoot.ts, parsed and measured without a browser so they can be tested alone.
export type Crop =
  | { kind: "selector"; selector: string }
  | { kind: "rect"; x: number; y: number; width: number; height: number };
export type Format = "png" | "webp";

export interface ShootOptions {
  out: string | undefined;
  themes: ("light" | "dark")[];
  sizes: string[];
  platform: string;
  crop: Crop | undefined;
  format: Format;
  maxWidth: number | undefined;
  all: boolean;
  names: string[];
}

const VALUE_FLAGS = new Set([
  "--out",
  "--themes",
  "--sizes",
  "--platform",
  "--crop",
  "--format",
  "--max-width",
]);

export function parseCrop(value: string): Crop {
  if (value.trim() === "") throw new Error("--crop needs a selector or x,y,w,h");
  if (/^[\d\s.,-]+$/.test(value)) {
    const raw = value.split(",").map((p) => p.trim());
    const parts = raw.map((p) => (p === "" ? Number.NaN : Number(p)));
    const [x, y, width, height] = parts;
    if (
      parts.length !== 4 ||
      parts.some((n) => !Number.isFinite(n)) ||
      x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0
    )
      throw new Error(`--crop takes x,y,w,h (w and h above 0), not ${value}`);
    return { kind: "rect", x, y, width, height };
  }
  return { kind: "selector", selector: value };
}

export function parseFormat(value: string): Format {
  if (value === "png" || value === "webp") return value;
  throw new Error(`--format takes png or webp, not ${value}`);
}

export function parseMaxWidth(value: string): number {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`--max-width takes a positive integer, not ${value}`);
  return Number(value);
}

export function parseShootOptions(argv: string[]): ShootOptions {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  };
  const themes = (flag("themes") ?? "light,dark").split(",");
  for (const theme of themes)
    if (theme !== "light" && theme !== "dark")
      throw new Error(`--themes takes light and dark, not ${theme}`);
  const crop = flag("crop");
  const maxWidth = flag("max-width");
  const skipped = new Set(
    argv.flatMap((a, i) => (VALUE_FLAGS.has(a) ? [i, i + 1] : a.startsWith("--") ? [i] : [])),
  );
  return {
    out: flag("out"),
    themes: themes as ("light" | "dark")[],
    sizes: (flag("sizes") ?? "1200x800,720x480").split(","),
    platform: flag("platform") ?? "",
    crop: crop === undefined ? undefined : parseCrop(crop),
    format: parseFormat(flag("format") ?? "png"),
    maxWidth: maxWidth === undefined ? undefined : parseMaxWidth(maxWidth),
    all: argv.includes("--all"),
    names: argv.filter((_, i) => !skipped.has(i)),
  };
}

/** The file's extension follows the format. A cropped or narrowed shot says so, so it does not overwrite the full one. */
export function shotFile(
  name: string,
  theme: string,
  size: string,
  format: Format,
  reduced = false,
): string {
  return `${name}.${theme}.${size}${reduced ? ".crop" : ""}.${format}`;
}

/**
 * The scale to capture at, relative to the device scale factor, and the width in pixels it gives.
 * `cssWidth` is what is captured (the viewport, or the crop). Never above 1: a small shot is not enlarged.
 */
export function outputSize(
  cssWidth: number,
  deviceScaleFactor: number,
  maxWidth: number | undefined,
): { scale: number; width: number } {
  const native = cssWidth * deviceScaleFactor;
  if (maxWidth === undefined || native <= maxWidth) return { scale: 1, width: Math.round(native) };
  const width = maxWidth;
  return { scale: width / native, width };
}

// Builds assets/icon.icns from assets/icon.svg. The result is checked in, so a build does not need
// this; run it (`bun run scripts/icon.ts`) after changing the svg.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const assets = join(dirname(fileURLToPath(import.meta.url)), "../assets");
const svg = readFileSync(join(assets, "icon.svg"), "utf8");

// An icns is a header and chunks, each a four-letter type and a PNG.
const SIZES: [type: string, px: number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

const chunks = SIZES.map(([type, px]) => {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: px } }).render().asPng();
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync(join(assets, "icon.icns"), Buffer.concat([header, body]));

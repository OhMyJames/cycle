import { memo } from "react";

/**
 * Cycle's own icons: a 16px grid, 1.25px round strokes in the text color.
 * Each value is the inside of an `<svg>`: one or more path `d` strings.
 */
const ICONS = {
  "panel-left": ["M2.5 3.5h11v9h-11z", "M6 3.5v9"],
  compose: [
    "M8.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5",
    "M12.2 2.3l1.5 1.5L8 9.5l-2 .5.5-2z",
  ],
  search: ["M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "M10.3 10.3l3.2 3.2"],
  settings: [
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    "M8 1.8v1.7M8 12.5v1.7M2.6 4.9l1.5.9M11.9 10.2l1.5.9M2.6 11.1l1.5-.9M11.9 5.8l1.5-.9",
  ],
  folder: ["M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"],
  archive: ["M2.5 3h11v3h-11z", "M3.5 6v6.5h9V6", "M6.5 8.5h3"],
  pin: ["M9.5 2l4.5 4.5-2 .5-2.5 2.5.3 3L8 14l-2.5-3.5L2.5 13.5 5.5 10.5 2 8l1.5-1.8 3 .3L9 4z"],
  more: ["M4 8h.01M8 8h.01M12 8h.01"],
  plus: ["M8 3v10M3 8h10"],
  x: ["M4 4l8 8M12 4l-8 8"],
  check: ["M3 8.5l3.2 3L13 4.5"],
  copy: ["M5.5 5.5h7v8h-7z", "M3.5 10.5v-8h7"],
  edit: ["M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3z"],
  trash: ["M3 4.5h10", "M6 4.5V3h4v1.5", "M4.5 4.5l.5 8.5h6l.5-8.5", "M6.8 7v4M9.2 7v4"],
  refresh: ["M13 8a5 5 0 1 1-1.5-3.6", "M13 2.5V5h-2.5"],
  "arrow-up": ["M8 13V3", "M4 7l4-4 4 4"],
  "arrow-down": ["M8 3v10", "M4 9l4 4 4-4"],
  stop: ["M4.5 4.5h7v7h-7z"],
  paperclip: [
    "M12.5 7.5L8 12a2.8 2.8 0 0 1-4-4l5-5a1.9 1.9 0 0 1 2.7 2.7L6.8 10.6a1 1 0 0 1-1.4-1.4L9.5 5",
  ],
  terminal: ["M2.5 3.5h11v9h-11z", "M5 6.5l2 1.5-2 1.5", "M8.5 10h2.5"],
  file: ["M4 2.5h5l3 3v8H4z", "M9 2.5v3h3"],
  "file-diff": ["M4 2.5h5l3 3v8H4z", "M8 6.5v3M6.5 8h3M6.5 11.5h3"],
  "git-branch": [
    "M5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M5 5.5v5",
    "M11 7c0 2-6 1.5-6 3.5",
  ],
  "git-fork": [
    "M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M4.5 5v1.5c0 1 1 1.5 3.5 1.5s3.5-.5 3.5-1.5V5",
    "M8 8v3",
  ],
  globe: [
    "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z",
    "M2 8h12",
    "M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12",
  ],
  wrench: ["M10.5 2.5a3 3 0 0 0-2.8 4L2.5 11.7l1.8 1.8 5.2-5.2a3 3 0 0 0 4-2.8l-2 1.5-1.5-1.5z"],
  sparkle: ["M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z"],
  lightbulb: ["M5.5 10a4 4 0 1 1 5 0v1.5h-5z", "M6.5 13.5h3"],
  "check-circle": ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M5.5 8.2l1.8 1.8 3.2-3.5"],
  "x-circle": ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M6 6l4 4M10 6l-4 4"],
  alert: ["M8 2.5l6 10.5H2z", "M8 6.5v3M8 11.2h.01"],
  clock: ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M8 4.5V8l2.2 1.5"],
  "chevron-down": ["M4 6l4 4 4-4"],
  "chevron-right": ["M6 4l4 4-4 4"],
  sun: [
    "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  ],
  moon: ["M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"],
  list: ["M5.5 4h8M5.5 8h8M5.5 12h8", "M2.5 4h.01M2.5 8h.01M2.5 12h.01"],
  overview: ["M2.5 3.5h11v9h-11z", "M10 3.5v9"],
  zap: ["M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"],
  eye: [
    "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z",
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ],
  image: ["M2.5 3.5h11v9h-11z", "M2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5", "M10.5 6.2h.01"],
  compress: ["M3 6h10M3 10h10", "M6 3.5l2 2 2-2M6 12.5l2-2 2 2"],
  message: ["M2.5 3.5h11v7.5H8l-3 2.5V11H2.5z"],
} as const;

export type IconName = keyof typeof ICONS;

export const Icon = memo(function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
});

/** A spinner that needs no script: one arc turned by CSS. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

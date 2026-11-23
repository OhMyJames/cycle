// The interface's icons: one line set from iconmcp (16-unit grid, 1.5 stroke, round), drawn in the text's colour.
// Add one here, never inline an svg in a component. DESIGN.md section 7 lists what is needed.
// Each is decoration: a control that has only an icon is named by a `Tip` (tip.tsx).
import type { ReactNode, SVGProps } from "react";

export type IconProps = { size?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "children" | "width" | "height" | "viewBox" | "aria-hidden" | "focusable"
>;

function Svg({ size, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** iconmcp: square */
export const StopIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      {/* Filled and small: a solid stop mark reads at the button's size, an outline at full size looked like a box. */}
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: chevron-down */
export const ChevronDownIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(90 8 8)">
      <path d="M5.875 3.75 L10.125 8 L5.875 12.25" />
    </g>
  </Svg>
);

/** iconmcp: server */
export const ServerIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1.2" />
      <rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1.2" />
      <circle cx="5" cy="4.5" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.5" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: arrow-up */
export const SendIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(-90 8 8)">
      <line x1="2.75" y1="8" x2="13.25" y2="8" />
      <path d="M8.5 3.25 L13.25 8 L8.5 12.75" />
    </g>
  </Svg>
);

/** iconmcp: plus */
export const PlusIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="8" y1="2.75" x2="8" y2="13.25" />
      <line x1="2.75" y1="8" x2="13.25" y2="8" />
    </g>
  </Svg>
);

/** iconmcp: more-horizontal */
export const MoreIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="3.25" cy="8" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.99" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="8" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: sliders */
export const SettingsIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="2.25" y1="4.75" x2="7.75" y2="4.75" />
      <circle cx="9.75" cy="4.75" r="2" />
      <line x1="11.75" y1="4.75" x2="13.75" y2="4.75" />
      <line x1="2.25" y1="11.25" x2="4.25" y2="11.25" />
      <circle cx="6.25" cy="11.25" r="2" />
      <line x1="8.25" y1="11.25" x2="13.75" y2="11.25" />
    </g>
  </Svg>
);

/** iconmcp: chevron-right */
export const ChevronRightIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M5.875 3.75 L10.125 8 L5.875 12.25" />
    </g>
  </Svg>
);

/** iconmcp: chevron-right, mirrored: the way back out of a page. */
export const ChevronLeftIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M10.125 3.75 L5.875 8 L10.125 12.25" />
    </g>
  </Svg>
);

/** iconmcp: check */
export const CheckIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M2.75 8.5 L6.25 12 L13.25 4.5" />
    </g>
  </Svg>
);

/** iconmcp: arrow-down */
export const ArrowDownIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(90 8 8)">
      <line x1="2.75" y1="8" x2="13.25" y2="8" />
      <path d="M8.5 3.25 L13.25 8 L8.5 12.75" />
    </g>
  </Svg>
);

/** iconmcp: copy */
export const CopyIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="2" />
      <path d="M3.5 10.75 L2.875 10.75 C2.53 10.75 2.25 10.47 2.25 10.125 L2.25 4.25 C2.25 3.145 3.145 2.25 4.25 2.25 L10.125 2.25 C10.47 2.25 10.75 2.53 10.75 2.875 L10.75 3.5" />
    </g>
  </Svg>
);

/** iconmcp: close */
export const CloseIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="3.75" y1="3.75" x2="12.25" y2="12.25" />
      <line x1="12.25" y1="3.75" x2="3.75" y2="12.25" />
    </g>
  </Svg>
);

/** iconmcp: message */
export const MessageIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M4.25 3 L11.75 3 C12.855 3 13.75 3.895 13.75 5 L13.75 9.25 C13.75 10.355 12.855 11.25 11.75 11.25 L7.25 11.25 L4.25 13.75 L4.25 11.25 L3.25 11.25 C2.698 11.25 2.25 10.802 2.25 10.25 L2.25 5 C2.25 3.895 3.145 3 4.25 3 Z" />
    </g>
  </Svg>
);

/** iconmcp: search */
export const SearchIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="7" cy="7" r="4.75" />
      <line x1="10.375" y1="10.375" x2="13.75" y2="13.75" />
    </g>
  </Svg>
);

/** iconmcp: alert */
export const WarningIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M9.311 4.36 L13.012 11.022 C13.567 12.021 12.844 13.25 11.701 13.25 L4.299 13.25 C3.156 13.25 2.433 12.021 2.988 11.022 L6.689 4.36 C7.26 3.332 8.74 3.332 9.311 4.36 Z" />
      <line x1="8" y1="6.25" x2="8" y2="8.75" />
      <circle cx="8" cy="10.9" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: alert-circle */
export const ErrorCircleIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5.25" x2="8" y2="8.75" />
      <circle cx="8" cy="11.15" r="0.99" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: brain */
export const ThoughtIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M8 3.5 A2.25 2.25 0 0 0 4 4.25 A2.5 2.5 0 0 0 2.75 8.5 A2.5 2.5 0 0 0 5 12.75 A2 2 0 0 0 8 13" />
      <path d="M8 3.5 A2.25 2.25 0 0 1 12 4.25 A2.5 2.5 0 0 1 13.25 8.5 A2.5 2.5 0 0 1 11 12.75 A2 2 0 0 1 8 13" />
      <line x1="8" y1="3.5" x2="8" y2="13" />
    </g>
  </Svg>
);

/** iconmcp: sidebar-left */
export const SidebarIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <line x1="6" y1="2.75" x2="6" y2="13.25" />
    </g>
  </Svg>
);

/** iconmcp: layout-dashboard */
export const OverviewIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <line x1="2.25" y1="7" x2="13.75" y2="7" />
      <line x1="7.5" y1="7" x2="7.5" y2="13.25" />
    </g>
  </Svg>
);

/** iconmcp: sidebar-right */
export const PanelIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <line x1="10" y1="2.75" x2="10" y2="13.25" />
    </g>
  </Svg>
);

/** iconmcp: download */
export const DownloadIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <line x1="8" y1="2.25" x2="8" y2="9.25" />
      <path d="M4.75 6 L8 9.25 L11.25 6" />
      <path d="M2.5 10.5 L2.5 12 C2.5 12.828 3.172 13.5 4 13.5 L12 13.5 C12.828 13.5 13.5 12.828 13.5 12 L13.5 10.5" />
    </g>
  </Svg>
);

/** iconmcp: paperclip */
export const AttachIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g transform="rotate(45 8 8)">
      <path d="M5.5 4.75 V11.25 A2.5 2.5 0 0 0 10.5 11.25 V3.5 A1.25 1.25 0 0 0 8 3.5 V9.75" />
    </g>
  </Svg>
);

/** iconmcp: plug */
export const PlugIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M4 5.5 H12 V8 A4 4 0 0 1 4 8 Z" />
      <line x1="6" y1="2" x2="6" y2="5.5" />
      <line x1="10" y1="2" x2="10" y2="5.5" />
      <line x1="8" y1="12" x2="8" y2="14.25" />
    </g>
  </Svg>
);

/** iconmcp: shield */
export const ShieldIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M8 2.25 L13 4.25 V7.75 C13 10.75 10.85 12.95 8 13.75 C5.15 12.95 3 10.75 3 7.75 V4.25 Z" />
    </g>
  </Svg>
);

/** iconmcp: shield-alert */
export const ShieldAlertIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M8 2.25 L13 4.25 V7.75 C13 10.75 10.85 12.95 8 13.75 C5.15 12.95 3 10.75 3 7.75 V4.25 Z" />
      <line x1="8" y1="5.75" x2="8" y2="8.5" />
      <circle cx="8" cy="10.75" r="0.9" fill="currentColor" stroke="none" />
    </g>
  </Svg>
);

/** iconmcp: folder */
export const FolderIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M2.25 4.75 C2.25 3.922 2.922 3.25 3.75 3.25 H6.25 L7.75 4.75 H12.25 C13.078 4.75 13.75 5.422 13.75 6.25 V11.25 C13.75 12.078 13.078 12.75 12.25 12.75 H3.75 C2.922 12.75 2.25 12.078 2.25 11.25 Z" />
    </g>
  </Svg>
);

/** iconmcp: file */
export const FileIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M9.25 2.25 H5 C4.172 2.25 3.5 2.922 3.5 3.75 V12.25 C3.5 13.078 4.172 13.75 5 13.75 H11 C11.828 13.75 12.5 13.078 12.5 12.25 V5.5 Z" />
      <path d="M9.25 2.25 V5.5 H12.5" />
    </g>
  </Svg>
);

/** iconmcp: refresh-cw */
export const RefreshIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <path d="M13.25 8 A5.25 5.25 0 0 1 3.9 11.25" />
      <path d="M2.75 8 A5.25 5.25 0 0 1 12.1 4.75" />
      <path d="M12.5 2.25 V4.75 H10" />
      <path d="M3.5 13.75 V11.25 H6" />
    </g>
  </Svg>
);

/** iconmcp: git-compare */
export const DiffIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <circle cx="4.5" cy="4" r="1.75" />
      <circle cx="11.5" cy="12" r="1.75" />
      <path d="M4.5 5.75 V9.5 C4.5 10.605 5.395 11.5 6.5 11.5 H8.5" />
      <path d="M7 10 L8.5 11.5 L7 13" />
      <path d="M11.5 10.25 V6.5 C11.5 5.395 10.605 4.5 9.5 4.5 H7.5" />
      <path d="M9 6 L7.5 4.5 L9 3" />
    </g>
  </Svg>
);

/** iconmcp's grid: terminal (a window with a prompt) */
export const TerminalIcon = ({ size = 16, ...rest }: IconProps) => (
  <Svg size={size} {...rest}>
    <g>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.75 6.25 L6.75 8 L4.75 9.75" />
      <line x1="8.25" y1="10" x2="11.25" y2="10" />
    </g>
  </Svg>
);

// The agents' own marks, as https://dashboardicons.com has them: a session's agent is shown by its logo, before its
// title in a row and in the header. These are brand marks, not the line set of icons.tsx: they keep their own colours
// (the OpenAI mark is one colour and takes the text's). An agent without a mark here is shown by its initial.
import type { ComponentType } from "react";

/** dashboardicons: claude-ai */
const ClaudeMark = () => (
  <svg viewBox="0 0 1200 1200" aria-hidden="true" focusable="false">
    <path
      fill="#d97757"
      d="M 233.95 800.21 L 468.64 668.53 L 472.59 657.10 L 468.64 650.73 L 457.20 650.73 L 417.98 648.32 L 283.89 644.69 L 167.59 639.86 L 54.92 633.82 L 26.57 627.78 L 3.3e-05 592.75 L 2.73 575.27 L 26.57 559.24 L 60.72 562.22 L 136.18 567.38 L 249.42 575.19 L 331.57 580.02 L 453.26 592.67 L 472.59 592.67 L 475.32 584.85 L 468.72 580.02 L 463.57 575.19 L 346.38 495.78 L 219.54 411.86 L 153.10 363.54 L 117.18 339.06 L 99.06 316.10 L 91.24 266.01 L 123.86 230.09 L 167.67 233.07 L 178.87 236.05 L 223.24 270.20 L 318.04 343.57 L 441.82 434.73 L 459.94 449.79 L 467.19 444.64 L 468.08 441.02 L 459.94 427.40 L 392.61 305.71 L 320.77 181.93 L 288.80 130.63 L 280.34 99.86 C 277.36 87.22 275.19 76.59 275.19 63.62 L 312.32 13.20 L 332.85 6.60 L 382.38 13.20 L 403.24 31.32 L 434.01 101.71 L 483.86 212.53 L 561.18 363.22 L 583.81 407.91 L 595.89 449.31 L 600.40 461.95 L 608.21 461.95 L 608.21 454.71 L 614.57 369.82 L 626.33 265.61 L 637.77 131.51 L 641.71 93.74 L 660.40 48.48 L 697.53 24.00 L 726.52 37.85 L 750.36 72 L 747.06 94.06 L 732.88 186.20 L 705.10 330.52 L 686.97 427.16 L 697.53 427.16 L 709.61 415.08 L 758.49 350.17 L 840.64 247.49 L 876.88 206.73 L 919.16 161.71 L 946.30 140.29 L 997.61 140.29 L 1035.38 196.42 L 1018.46 254.41 L 965.63 321.42 L 921.82 378.20 L 859.00 462.76 L 819.78 530.41 L 823.40 535.81 L 832.75 534.92 L 974.65 504.72 L 1051.32 490.87 L 1142.81 475.16 L 1184.21 494.49 L 1188.72 514.14 L 1172.45 554.33 L 1074.60 578.49 L 959.83 601.44 L 788.93 641.87 L 786.84 643.40 L 789.26 646.38 L 866.25 653.63 L 899.19 655.40 L 979.81 655.40 L 1129.93 666.60 L 1169.15 692.53 L 1192.67 724.26 L 1188.72 748.42 L 1128.32 779.19 L 1046.81 759.86 L 856.59 714.60 L 791.35 698.33 L 782.33 698.33 L 782.33 703.73 L 836.69 756.88 L 936.32 846.84 L 1061.07 962.81 L 1067.43 991.49 L 1051.40 1014.12 L 1034.49 1011.70 L 924.88 929.23 L 882.60 892.10 L 786.84 811.48 L 780.48 811.48 L 780.48 819.94 L 802.55 852.24 L 919.08 1027.40 L 925.12 1081.12 L 916.67 1098.60 L 886.46 1109.15 L 853.28 1103.11 L 785.07 1007.35 L 714.68 899.51 L 657.90 802.87 L 650.97 806.81 L 617.47 1167.70 L 601.77 1186.14 L 565.53 1200 L 535.32 1177.04 L 519.30 1139.91 L 535.32 1066.55 L 554.65 970.79 L 570.36 894.68 L 584.53 800.13 L 592.99 768.72 L 592.42 766.63 L 585.50 767.51 L 514.22 865.36 L 405.82 1011.86 L 320.05 1103.67 L 299.51 1111.81 L 263.91 1093.36 L 267.22 1060.42 L 287.11 1031.11 L 405.82 880.10 L 477.42 786.52 L 523.65 732.48 L 523.32 724.67 L 520.59 724.67 L 205.28 929.39 L 149.15 936.64 L 124.99 914.01 L 127.97 876.88 L 139.40 864.80 L 234.20 799.57 L 233.87 799.89 Z"
    />
  </svg>
);

/** dashboardicons: openai. Codex is OpenAI's agent; the site's "codex" is another app. */
const OpenAiMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
    />
  </svg>
);

/**
 * dashboardicons (selfhst): google-antigravity. It is only drawn as a picture there (a gradient, no SVG), so it is
 * kept here as a 64px PNG: sharp at 14px on a 3x screen, and a data URL, which the page's CSP allows (img-src data:).
 */
const ANTIGRAVITY_PNG =
  "data:image/png;base64,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";

const AntigravityMark = () => <img src={ANTIGRAVITY_PNG} alt="" draggable={false} />;

/** dashboardicons: pi-coding-agent. One colour (white there): it takes the text's, so it reads light and dark. */
const PiMark = () => (
  <svg viewBox="0 0 800 800" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);

const MARKS: Record<string, ComponentType> = {
  claude: ClaudeMark,
  codex: OpenAiMark,
  agy: AntigravityMark,
  // pi is not in harnesses.ts yet (CYCL-154): its mark waits here for its id.
  pi: PiMark,
};

/**
 * An agent's logo, by its id; its name is the logo's name for a screen reader, and under the pointer unless `quiet`
 * (where something around it says more under the pointer, as a row of an environment that is away).
 */
export function AgentLogo({
  agentId,
  name,
  quiet = false,
  decorative = false,
}: {
  agentId: string;
  name: string;
  quiet?: boolean;
  /** True when the agent's visible name is right beside the mark (e.g. a Settings nav tab). */
  decorative?: boolean;
}) {
  const Mark = MARKS[agentId];
  const inner =
    Mark !== undefined ? (
      <Mark />
    ) : (
      <span data-kind="initial">{(Array.from(name)[0] ?? "").toUpperCase()}</span>
    );
  if (decorative) {
    return (
      <span data-slot="agent-logo" aria-hidden="true">
        {inner}
      </span>
    );
  }
  return (
    <span data-slot="agent-logo" role="img" aria-label={name} title={quiet ? undefined : name}>
      {inner}
    </span>
  );
}

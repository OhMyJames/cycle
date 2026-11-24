// How a state is drawn: a colour, a shape and a word, so it is never told by colour alone (DESIGN.md section 3).
import type { AgentAuthState, ConnectionState } from "../api.ts";
import type { Mark } from "../sessions.ts";
import { CloseIcon } from "./icons.tsx";

export type Tone = "accent" | "attention" | "success" | "danger" | "muted";
export type Shape = "solid" | "pulse" | "square" | "ring" | "cross";

export function StatusDot({ tone, shape }: { tone: Tone; shape: Shape }) {
  if (shape === "cross") return <CloseIcon size={12} data-slot="dot" data-tone={tone} />;
  return <span data-slot="dot" data-tone={tone} data-shape={shape} aria-hidden="true" />;
}

export const LOCATION_STATE: Record<
  ConnectionState,
  { word: `location.state.${ConnectionState}`; tone: Tone; shape: Shape }
> = {
  connected: { word: "location.state.connected", tone: "success", shape: "solid" },
  connecting: { word: "location.state.connecting", tone: "accent", shape: "ring" },
  reconnecting: { word: "location.state.reconnecting", tone: "attention", shape: "ring" },
  closed: { word: "location.state.closed", tone: "danger", shape: "cross" },
};

/** How a row's one mark is drawn (sessions.ts `markOf`): the words are `mark.*` in the messages. */
export const MARK_STYLE: Record<Mark, { tone: Tone; shape: Shape }> = {
  "needs-you": { tone: "attention", shape: "square" },
  running: { tone: "accent", shape: "pulse" },
  background: { tone: "accent", shape: "ring" },
  unread: { tone: "accent", shape: "solid" },
};

/** What a mark says in words, as the keys of the messages: for a row and for the badge of the switcher. */
export const MARK_WORD = {
  "needs-you": "mark.needsYou",
  running: "mark.running",
  background: "mark.background",
  unread: "mark.unread",
} as const;

export const AGENT_AUTH_DOT: Record<AgentAuthState, { tone: Tone; shape: Shape }> = {
  signed_in: { tone: "success", shape: "solid" },
  signed_out: { tone: "muted", shape: "ring" },
  signing_in: { tone: "accent", shape: "pulse" },
  signing_out: { tone: "accent", shape: "ring" },
  auth_unknown: { tone: "attention", shape: "ring" },
  binary_unavailable: { tone: "danger", shape: "cross" },
};

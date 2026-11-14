# @cycle/ui

The page. The root [AGENTS.md](../../AGENTS.md) applies here in full; this file adds what is particular
to this package.

## Controls

These hold for every control, whoever wrote its behavior. The check does not enforce them.

- Every control has a name a screen reader can say: its visible text, a `<label>` around it, or
  `aria-label`. A placeholder is not a name, and neither is a `title`: `Tooltips` takes the title
  away while it shows it.
- A group of controls has a name too: `Segmented` takes a `label`.
- A key handler that acts on Enter asks `isComposing(event)` from `@ui-sdk/core` first, not the
  event's own `isComposing`: Safari reports the Enter that confirms an input method's text as not
  composing.
- A choice that runs without asking, like Full access, is taken by a press, never by an arrow key
  that happens to land on it: mark it `deliberate` in `Segmented`.
- A list whose rows can be added, removed or reordered is keyed by an id, not by its index.
- Text has 4.5:1 against what is behind it, and a control's edge, focus ring and state fill 3:1, in
  both themes. Measure it in the browser when a color or a token changes.

## ui-sdk

`@ui-sdk/react` and `@ui-sdk/core` are installed for building interactions: unstyled components and
the behaviors under them (focus, keys, selection, popups, typeahead, drag and drop, ARIA). They are
a beta, pinned to an exact version, and their API may change with any release.

Before using ui-sdk, follow the `ui-sdk` skill (`.agents/skills/ui-sdk`), and read
`node_modules/@ui-sdk/react/docs/llms.txt` in this package. To build a new component, also search
`node_modules/@ui-sdk/react/docs/core.md` by heading, and read `rendering.md` next to it.

The skill in this repository is edited for Cycle: its tests, its commands, its styles and its step
for agents follow the rules here, and its "In Cycle" section lists what was changed. Upstream's own
copy does not, so an update from upstream is merged by hand.

- A new interaction is built on ui-sdk. `Segmented` already is. The other components here (`Menu`,
  `Dialog`, the palette, the model picker, the sidebar) are written by hand and work: move one only
  when the owner asks.
- A ui-sdk part takes Cycle's class with `className`, and its states are styled in `src/styles/`.
  Never import `@ui-sdk/core/web.css`.
- `createAgent`, agent tools and WebMCP let an agent read and operate the page, which holds the
  connection token and can send prompts and approve commands. That is a security boundary: stop and
  ask the owner first.
- Import each component from its own entry, as `@ui-sdk/react/menu`. Upgrade both packages together,
  to the same exact version, and read the changelog first.

---
name: ui-sdk
description: Builds interfaces with ui-sdk in React, Vue, Svelte, Solid or web components. Covers choosing and composing its components, building a component or behavior it doesn't ship from @ui-sdk/core (like a stepper, splitter, transfer list or emoji picker), making the interface usable by agents through createAgent, agent tools and WebMCP, and testing keyboard, focus, ARIA, server rendering and right to left, including writing tests for an existing component. Use whenever a project has @ui-sdk/* installed or the user mentions ui-sdk.
---

# Build with ui-sdk

## In Cycle

This copy is edited for Cycle; `skills-lock.json` records the upstream it came from. An update from
upstream must be merged by hand, keeping what this section says.

- ui-sdk is used in one package, `packages/ui`, in React. Its docs are in
  `packages/ui/node_modules/@ui-sdk/react/docs/`.
- Commands run with `bun`, never `npm` or `npx`. Finished work passes `bun run check`.
- The look is Cycle's design system, `.agents/designs/design-system.md`. `@ui-sdk/core/web.css` is
  never imported, so [references/styles.md](references/styles.md) applies only for its Slots, State
  and Color sections. Icons are Cycle's own, in `packages/ui/src/components/icons.tsx`.
- Tests follow Cycle's limits: [references/testing.md](references/testing.md) says how.
- Nothing is made agent-ready unless the owner asks:
  [references/agent-ready.md](references/agent-ready.md) says why.

ui-sdk is a library of UI behaviors: keyboard navigation, focus, selection, dismissal, popups, drag and drop and the ARIA they need. Its components are built from those behaviors and render no styles of their own, in React, Vue, Svelte, Solid and web components. `@ui-sdk/core/web.css` gives them an optional default look. When a component is missing, you build it from the same behaviors in `@ui-sdk/core`, and it gets the same keyboard, focus, server rendering and right to left support.

## Read first

The docs for the installed version ship in each package, as Markdown:

- `node_modules/@ui-sdk/<framework>/docs/llms.txt` is the index. Read it first. `<framework>` is `react`, `vue`, `svelte`, `solid` or `web`.
- Then read only the pages your task needs, like `docs/components/select.md`. Don't read the whole `docs/` folder; it's large.
- An interface built from our components doesn't need `docs/core.md`. Only path 2 below does, and even then you search it by heading: it's over 300 KB. `docs/rendering.md` sits next to it in the same `docs/` folder.
- Don't read compiled JavaScript in `dist/*.js`, even to debug. The docs and the `.d.ts` types are the API; when they don't answer, write a small test that tries it.

The same docs are online at https://ui-sdk.dev/docs. Prefer the installed copy: it matches the version in the project.

Cycle's page never loads `web.js` or `web.css` from ui-sdk.dev: it serves only what the daemon built.

## Pick your path

1. **Build an interface from our components**, like a settings page, a form or a command palette: read [references/build-interface.md](references/build-interface.md).
2. **Build a component or behavior ui-sdk doesn't ship**, or extend one of ours: read [references/create-component.md](references/create-component.md).

Most interfaces only need path 1. When one part of it needs a component we don't have, follow path 2 for that part.

Every path ends the same way:

3. **Test it**: [references/testing.md](references/testing.md).

Making it agent-ready is not a step in Cycle. Read [references/agent-ready.md](references/agent-ready.md) only when the owner asks for it.

## Rules for every path

- **Import from entries.** Each component has its own entry, like `@ui-sdk/react/select`. There's no root import from a framework package. Never import `@ui-sdk/core/internal/*`.
- **One shape everywhere.** A root and its parts, nested as the component page's Composition shows. Change a part's element with `render`, never an `as` prop.
- **Default or controlled.** `defaultValue` to start, or `value` with `onValueChange(value, details)` to control it (each framework's idiom: `v-model` in Vue, `bind:value` in Svelte, properties and events in web components). `details` has `reason`, `source` and `cancel()`.
- **Name every control.** Use the component's label part (`FieldLabel`, `SelectLabel`, `DialogTitle`), or `aria-label` when there's no visible text. People using screen readers and agents both find controls by name.
- **Style from state.** Target `data-slot` and state attributes like `data-open` or `data-pressed`, and the CSS variables each component lists. Never inline styles for state, and never generated ids. Write them in `packages/ui/src/styles/`, with Cycle's tokens and classes: a part takes a `className`, so an existing class like `.segmented` keeps working.
- **No layer to declare.** Cycle's styles are in no layer, so they already win over ui-sdk's behavior CSS, which is in `@layer ui-sdk`.
- **Check color.** Text needs 4.5:1 against what's behind it, and control edges, focus rings and state fills 3:1. jsdom can't see color, so check it in a real browser.
- **Key lists by value or id**, never by index.
- **Right to left needs no provider.** Components read the direction from the page.
- **Comments are rare.** Write one only when a reader would get the code wrong without it, like a browser quirk or a trade-off, in one or two lines. Never comment what the code does, what a value is, or which section starts here, and no JSDoc blocks on app code.
- **Don't hand-roll what we ship, in new code.** Before you write any `role=` attribute, look for the component in the table in [references/build-interface.md](references/build-interface.md). Cycle's older components (`Menu`, `Dialog`, the palette, the model picker, the sidebar) are written by hand and stay so until the owner asks for one to be moved: don't rewrite one in passing, and don't copy its hand-written roles into something new.
- **A choice that is dangerous is never taken by moving.** In a radio group, the arrow keys check what they land on. Where one option runs without asking, like Full access, cancel a change whose `details.reason` is `list-navigation`, as `Segmented` in `packages/ui/src/components/controls.tsx` does for an option marked `deliberate`.

## When you're done

1. **Run the gate.** `bun run check` typechecks each package under its own configuration, and runs the lint, the format check, the boundaries and the unit tests.
2. **Test it** as testing.md says: unit tests for what is pure, the demo in a real browser for the rest. If a test finds a bug in code you were asked only to test, report the bug and fix it or ask: Cycle allows no skipped, failing-on-purpose or todo tests.
3. **Read every comment in your diff.** Delete it unless it names a browser quirk, an APG rule or a trade-off, and cut what's left to two lines. Turn JSDoc on app code into a plain comment or delete it. Never tell the reader to replace something.
4. **Report** each command you ran with its exit code, anything you couldn't check, and anything the docs or types got wrong or left out.

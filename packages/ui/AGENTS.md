# @cycle/ui

The page. The root [AGENTS.md](../../AGENTS.md) applies here in full; this file adds what is particular
to this package.

## ui-sdk

`@ui-sdk/react` and `@ui-sdk/core` are installed for building new interactions: unstyled components
and the behaviors under them (focus, keys, selection, popups, typeahead, drag and drop, ARIA). They are
a beta, pinned to an exact version, and their API may change with any release.

Before using ui-sdk, follow the `ui-sdk` skill (`.agents/skills/ui-sdk`), and read
`node_modules/@ui-sdk/react/docs/llms.txt` in this package. To build a new component, also search
`node_modules/@ui-sdk/react/docs/core.md` by heading, and read `rendering.md` next to it.

The skill is written for any project. Where it and Cycle disagree, Cycle's rules win:

- Use it for a new interaction, or when the owner asks for a component to be moved onto it. The
  components already here are written by hand and work: do not rewrite one because the skill calls a
  hand-written `role=` a bug.
- The look is the [design system](../../.agents/designs/design-system.md). Never import
  `@ui-sdk/core/web.css`; style parts from their `data-slot` and state attributes, in `src/styles/`,
  with Cycle's tokens. Icons are Cycle's own.
- Tests follow the root's Testing section: `bun test`, in `test/`, no timers or network, 200ms each.
  Do not install vitest, jsdom or Testing Library, and do not use `test.fails`. Check behavior that
  needs a real browser in `bun run demo`, with Playwright.
- Skip the skill's "make it agent-ready" step. `createAgent`, agent tools and WebMCP let an agent read
  and operate the page, which holds the connection token and can send prompts and approve commands.
  That is a security boundary: stop and ask the owner first.
- Commands run with `bun`, never `npm` or `npx`, and the finished work passes `bun run check`.
- Import each component from its own entry, as `@ui-sdk/react/menu`. Upgrade both packages together,
  to the same exact version, and read the changelog first.

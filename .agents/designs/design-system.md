# Cycle design system

Version 0.9. It continues old-cycle's v0.8 and is written for this codebase: plain CSS in
`packages/ui/src/styles`, with the values in `tokens.css` and the controls as classes in `base.css`.
When the experience and this document disagree, change this document first, then bring every screen
in line with it.

## Principles

1. Gray first, and color wherever it tells the owner something: each color has one meaning
   (see Color roles), and what is only decoration stays gray.
2. Shape follows the icons: 1.25 strokes with round ends, so radii are generous and concentric.
3. Say it once. A page's name is in its heading, not also in the title bar; a row's meaning is in its
   words, so an icon goes only on an icon-only button, a disclosure, a status, or a navigation row.
4. Group by turn. A turn's work folds into one line; the reply is what stays in view.
5. Edges, then shadows. A surface is told apart by a 1px border; a shadow is only for what floats.
6. The owner never lands on a dead end: an empty screen offers the next step itself.

## Tokens

Colors, type, radii, motion and shadows are in `tokens.css`, for light and dark. Use the semantic
name (`--text-secondary`, `--surface-composer`, `--border-default`), never a raw value.

| Type    | Size / line | Use                                                  |
| ------- | ----------- | ---------------------------------------------------- |
| Caption | 12 / 18     | Notes under a control, counts, key hints             |
| Meta    | 13 / 20     | Secondary lines, notices, chips                      |
| Body    | 14 / 22     | Everything else                                      |
| Title   | 16 / 24     | Page and dialog headings, a reply's headings         |
| Welcome | 20 / 28     | The one line above a new session. Nothing is larger. |

Weights are regular (420 in light, 400 in dark), medium (500) for headings and names, and semibold (600) only for bold text
in a reply. Code is JetBrains Mono, or the platform's monospace.

Radii: 4 (checkbox, inline code), 6 (notice), 8 (controls, rows), 12 (cards, menus), 16 (a
message), 20 (the composer). A control inside a container sits so the two curves are concentric.

Motion: 100ms for a state, 160ms for a disclosure, 200ms to enter. Nothing bounces.

## Color roles

The interface is gray so that its colors can be read at a glance. Each color means one thing,
everywhere:

| Color                         | Means                    | Where                                                                                                                                   |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Brand red (`--brand-accent`)  | Alive, now               | A running session, the working loader, today's bar in Usage                                                                             |
| Blue (`--accent-interactive`) | Goes somewhere, measures | Links, a file a reply names, the context ring and the limit meters while there is room, the selection                                   |
| Green (`--state-success`)     | Good, added              | A connected server, a signed-in account, added lines, a new file's letter                                                               |
| Amber (`--state-warning`)     | Needs the owner          | A session that waits, the approval card's edge and wash, Full access, a warning notice, a nearly full context, a modified file's letter |
| Red (`--state-error`)         | Failed, removed          | A failed tool or server, an error notice, removed lines, a deleted file's letter                                                        |
| Code red (`--text-code`)      | Code in prose            | Inline code                                                                                                                             |
| Syntax colors (`--hl-*`)      | Kinds                    | Code blocks, and the tint of a file's icon by its kind in the Files and Changes panels                                                  |

A wash is the color at about 5% on its surface, an edge at about a third; text and icons use it
in full. Navigation, buttons and the composer stay gray: the primary action is the darkest thing,
not the most colorful.

## Layout

- The sidebar is 248 wide, 200 to 420 by its edge; a double-click on the edge puts it back. Rows
  are 28 high, 2 apart, with the icon in a 24 column and text from 36.
- The list of sessions is one Tab stop. Up and down move between its rows, Home and End to its
  ends, right to the buttons at a row's end and left back.
- A session that waits for the owner has "Answer" on its row, in amber. It opens the approval card
  beside the row, with the command in it, so it is answered without leaving the conversation in
  view. The focus starts on Deny.
- While Settings is open the sidebar is Settings' own: the way back, then its sections, one shown
  at a time. The sidebar always lists what the main area can show.
- The title bar is 42 high. It names the open session and its folder; on a page it is empty.
- The content column is 768 wide. Blocks in a turn are 16 apart, turns 40.
- A side panel is 460 wide, 320 to 900; a double-click on its edge puts it back. In a window
  900 wide or less it lies over the conversation, under the title row, whose buttons still switch
  and close it.
- Pages (Settings, Connector, Automatic) are one column, 720 with its padding: heading, a lead line, then sections
  of cards.

## Controls

Four kinds, each a class:

| Kind    | Class                         | For                                     |
| ------- | ----------------------------- | --------------------------------------- |
| Ghost   | `.ghost`, `.icon-button`      | Most actions; no edge until hovered     |
| Outline | `.button`                     | A secondary action beside a primary one |
| Primary | `.button.primary`             | The one action a surface is for         |
| Row     | `.menu-item`, `.nav-row`, ... | A choice in a list                      |

- States: hover fills with `--surface-control-hover`; an open menu keeps its trigger in hover;
  disabled changes the text color and does not fade the control. Disabled text keeps 3:1 against
  its surface: it reads as off, and it still reads.
- A control drawn smaller than 24 (the switch, a tab's close) takes a press within 24.
- Focus: `:focus-visible` only. A control gets the outline, a field gets the edge and glow.
- A destructive action is `.button.danger` and always behind a confirmation that says what is lost.
  The confirmation opens with the focus on Cancel, so a second Enter never removes anything.
- A switch (`Switch`) is for a setting that applies at once; a checkbox for a choice inside a
  form or dialog that applies with its action. Both are Cycle's own drawing, never the platform's.
- A select is `select.field`, with the disclosure chevron drawn in. Prefer `Menu` when the choices
  need a second line or an icon.
- `Segmented` picks one of two to four short choices. Tabs switch what a region shows.

### Choices

A list never shows a bare "Default" or "Recommended". It names the choice and marks it:
"Auto (default)", "System (default)".

### The composer

Radius 20, padding 12. The controls under the input (model and effort, permissions) are plain words
with no chevron; their menus open upward. The send button is the only filled control. The line
under it says what the keys do now, and changes with the state (send, queue, steer).

### The composer's lists

Typing `/` at the very start lists commands, then skills; typing `@` after a space lists the
folder's files. Every row is one line: icon, name, then what it is in the muted color, fading
where it does not fit. Kinds are under headings only when there is more than one. A name that
starts with what was typed comes before one that holds it; a plugin's skills are one row; `@`
with nothing typed shows what the folder holds, folders first, and at most eight paths. Hidden
files show only when the query has a dot. Under the files, `@` lists the owner's other sessions,
this folder's first, at most four. A picked session reads `@title` in the composer and is a
mention in the sent message: its title on a faint blue wash, which opens that session.

### Disclosure

One glyph, `chevron-down`, turned -90° when closed. On a tool row it shows only on hover.

## Panels

A panel is a card at the right edge that comes in from that edge. Its header is 30 high: what it
looks at on the left, its own actions and Close on the right. Rows are 28 high, as the sidebar's.

- **Overview** is facts, a label in the muted color and its value in the primary one. A fact that
  goes somewhere is a control: the folder opens Files, a server opens the Connector. A server has
  a dot in its status color.
- **Changes** lists files as cards. A file's header carries its icon, its counts and its status
  letter, and stays at the top while its diff scrolls. A diff has no git header lines: a later
  part of the file starts under a thin band that names where it is.
- **Files** is a tree with a guide under each open folder. The arrow keys move through it: up and
  down between rows, right to open a folder, left to close it, down from the filter into the list.
- A file's icon is tinted by its kind in both, and nowhere else.

## Text that does not fit

A line that overflows fades out at its edge (`.fade-x`, or `.fade-x-start` to keep the end of a
path); a scroller fades where it hides content (`.fade-y`). There is no ellipsis and no `truncate`
class. The full text is in the `title`.

## The conversation

- The owner's message is a bubble at the right, radius 16. The reply is plain text on the page.
- A turn's work is one summary line ("Listed 1 folder, read 1 file, ran 1 command") that opens to
  its rows. A single piece of work is its row alone.
- What happens beside the conversation (a hook's addition, news of a helper agent) is one line in
  the style of a row, which opens to its text when it has one.
- Questions a reply leaves for later sit under it, each with its answers as buttons. An answer goes
  to the composer, never straight to the agent.
- Going back to before one of the owner's messages is under that message, and asks first: it
  removes the turns for good, and the files stay as they are.
- The tail, under the last turn, in this order: queued prompts, the approval that waits for the
  owner or else the status line (what the agent is doing, for how long), then one notice. What the
  owner must act on is never below something they can ignore.
- The approval card never takes the focus, so an Enter meant for the composer cannot allow a
  command. `⌘ ↵` allows once and `⌘ .` denies, and the card says so; `⌘ ↵` stays the composer's
  while it holds text to steer with. Allowing for the whole session is a press, never a key.
- A status wording stays at least 650ms, so it does not flicker.
- The scroll-to-bottom button floats above the composer, with the composer's shadow. While it
  shows, the conversation fades out behind it, so it never lies on a line someone is reading.

## Interaction

- The keyboard always has somewhere to go. A letter typed with nothing focused goes to the
  composer; opening a session focuses it.
- A menu takes the focus when it opens: the arrow keys, Home, End and typing a name move in it,
  and Escape gives the focus back to its button.
- A dialog takes the focus when it opens, keeps Tab inside itself, and gives the focus back to
  where it was when it closes, or to the menu's button when a menu's row opened it. Escape closes the topmost thing only: a dialog before the panel or
  menu it was opened from.
- Every control with a `title` shows Cycle's own tip: after the pointer rests 500ms, at once when
  moving from one tip to the next, above the control unless it is at the window's top, and never
  cut by the window's edge. A tip names the control and its shortcut; it never holds something the
  owner needs to act.
- What was typed is never lost: each session keeps its unsent text, and a failed send puts the
  text back.

## Empty and first states

- Nothing open and a known folder: a new session, ready to type in. No "pick something" screen.
- No folder yet: one heading, one line, one primary button that opens the folder chooser.
- An empty list says what will be there in a muted line; an empty section of a page is an
  `.empty-card` with a line of examples.

## Elevation

| Surface         | Edge | Shadow              |
| --------------- | ---- | ------------------- |
| Page, sidebar   | none | none                |
| Card, notice    | 1px  | none                |
| Composer        | 1px  | `--shadow-composer` |
| Menu, popover   | 1px  | `--shadow-popover`  |
| Dialog, palette | 1px  | `--shadow-dialog`   |

## Icons

Cycle's own, in `packages/ui/src/components/icons.tsx`: a 16 box, 1.25 stroke, round caps and joins,
`currentColor`. No icon library. A drawing inside CSS (the checkbox's check, the select's chevron)
follows the same stroke.

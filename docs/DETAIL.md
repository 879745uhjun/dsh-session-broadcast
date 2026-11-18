# Session broadcast

Send one message to several sessions at once, from a button in the composer
toolbar.

## What you get

The conversation composer gains a speaker icon on the left of its toolbar.
Clicking it opens a dialog with three parts: a message box, a filterable list of
every session, and a footer with the send button. Ticking sessions and sending
delivers the same text to each of them.

Each row shows the session title, its workspace, and a tag when the session is
running, is a subagent, or is an unused new session. The list is ordered with
running sessions first, then by last activity, so a broadcast meant to unblock
work is easy to aim.

## Boxes

When the session-boxes plugin is installed, the dialog also shows the box
classification that plugin owns. It reads the durable state from the same
same-origin route the sidebar uses, once per open:

- every row carries a badge for each box it belongs to, coloured like the box
  header in the sidebar, and a sub-box badge reads as `parent › child`;
- a chip row filters the list by one box, by "ungrouped", or by nothing, and
  each chip shows that box's colour and current session count;
- a parent chip covers its sub-boxes, so **Select all** while that chip is
  active targets the whole branch.

The chips only filter. They never change membership, and the plugin never
writes to the box store. If the box plugin is absent or its route fails, the
chip row and badges disappear and the picker keeps working.

## Appearance

The dialog is built from theme tokens only, so it follows the light and dark
palettes without a separate stylesheet. Box colours are the one exception:
they are data, not chrome, so they live in a `--dshc-*` eight-colour palette
with a light set on `:root` and a dark override on
`body[data-ds-dark-theme]`; the bundle itself carries no colour literals
outside those two blocks. Every class is scoped to the `sbc-`
prefix, which keeps it from colliding with the box plugin's own `dsb-` styles
or with any other plugin that injects CSS into the same document.

## Filters

Boxes are one facet. The picker offers three more when their plugins are
installed, and all of them AND together:

- **Unfinished todo** reads `/session-todos`. Only a recorded todo with
  `done: false` counts; a session with no entry is untouched, not pending.
- **Star rating** reads `/session-stars` and keeps sessions at or above a
  threshold chosen from a small 1–5 select (default 3).
- **Recent activity** keeps sessions whose catalog `updatedAt` falls inside the
  last 24 hours. It needs no extra request.

Each row shows a badge for every active facet, so a filtered list never leaves
the reason implicit. **Select all** and **Clear** act on the fully filtered
rows, which is what makes "one box, five stars, send" a two-click operation.

Every peer read is independent and has a hard 1.5 s deadline. A missing route,
a timeout, or a payload without its expected key disables exactly that chip and
leaves the rest working; when no facet source is available at all, the dialog
falls back to the plain session list. The plugin only reads these routes — it
never writes to another plugin's data or touches its files.

## Delivery semantics

The plugin does not invent a messaging channel. Each target is prompted through
the Client Session Controller, exactly as the composer does it, with these
consequences:

- The message becomes an ordinary durable user message, visible in that
  session's history and to its agent.
- Delivery mode is chosen in the dialog. The default is `queue`: a session that
  is mid-turn receives the message after its current turn, so a broadcast never
  interrupts running work. Turning on the interrupt toggle sends with `steer`,
  which drops the target's current turn and handles the message immediately.
- An idle session starts a new turn, and a cold session is resumed on the Host.
- The plugin holds its reference to a target only while the send is in flight,
  so the picker does not keep sessions open afterwards.

Sending writes up to three targets at once and publishes progress. A target
never waits for its conversation history first: the reference is retained and
prompted without awaiting `ready`, so a broadcast does not pull a history page
(up to 500 messages) per target, and releasing the reference tears that opening
down. Results are stored by target order, so the list reads in display order
even when replies finish out of order. A rejection is
recorded against that session and the batch continues. When the batch finishes,
the dialog lists one row per target, marks each success or failure, and offers
**Retry failed**, which resends only the failures and keeps the draft text.

## Limits

- Text only: attachments and images cannot be broadcast.
- The draft lives in memory for the current page; it is not persisted.
- The picker can only offer sessions the signed-in profile can list.
- "Queued" means the Host accepted the message, not that the target session has
  finished acting on it.

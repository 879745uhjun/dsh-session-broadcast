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

## Delivery semantics

The plugin does not invent a messaging channel. Each target is prompted through
the Client Session Controller, exactly as the composer does it, with these
consequences:

- The message becomes an ordinary durable user message, visible in that
  session's history and to its agent.
- Delivery mode is `queue`: a session that is mid-turn receives the message
  after its current turn, so a broadcast never interrupts running work.
- An idle session starts a new turn, and a cold session is resumed on the Host.
- The plugin holds its reference to a target only while the send is in flight,
  so the picker does not keep sessions open afterwards.

Sending runs one session at a time and publishes progress. A rejection is
recorded against that session and the batch continues. When the batch finishes,
the dialog lists one row per target, marks each success or failure, and offers
**Retry failed**, which resends only the failures and keeps the draft text.

## Limits

- Text only: attachments and images cannot be broadcast.
- The draft lives in memory for the current page; it is not persisted.
- The picker can only offer sessions the signed-in profile can list.
- "Queued" means the Host accepted the message, not that the target session has
  finished acting on it.

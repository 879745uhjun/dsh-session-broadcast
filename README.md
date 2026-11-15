# Session broadcast

Send one message to several DeepSeek Harness sessions at once.

A small speaker icon sits in the conversation composer toolbar. Click it, tick
the sessions you want, type the message once, and send. Every selected session
receives the same user message.

## What it does

- **One message, many sessions.** The picker lists every session the sidebar
  knows, with its title, workspace, running state, subagent and new-session
  tags. Nothing is preselected, so a broadcast is always an explicit choice.
- **Boxes come along.** When the session-boxes plugin is installed, the dialog
  reads its classification from the same route the sidebar uses: every row
  shows the box (or boxes) it belongs to, and a chip row filters the list by
  box, by "ungrouped", or not at all. A parent chip covers its sub-boxes, so
  "select all" inside a box sends to that whole branch. The chips are refreshed
  each time the dialog opens, so a rename or a moved session is reflected
  immediately; without that plugin the dialog simply has no chips.
- **Queued, never interrupting.** Each target receives the text through the
  same path the composer uses, with `queue` delivery: a session that is
  mid-turn gets the message after its current turn instead of being cut off.
  An idle session starts a new turn as if you had typed it there.
- **Honest results.** Delivery runs one session at a time and reports a result
  per target: queued, or the Host's rejection code and message. **Retry failed**
  resends only the failures; the draft text stays in the box.

## Usage

1. Open any conversation.
2. Click the speaker icon on the left of the composer toolbar.
3. Optionally filter the list, then tick the sessions.
4. Type the message and send with the button or Ctrl/Cmd+Enter.

Search matches session titles, workspace names, and session ids. **Select all**
and **Clear** act on the filtered rows only, so a box chip plus **Select all**
reaches every session in that box.

## Boxes

The chip row is a filter, not a setting: it never edits membership. Clicking
the active chip again clears it. Chips carry the box's own colour and its
current session count, and a sub-box chip reads as `parent › child`. When the
session-boxes plugin is absent or its route fails, the chip row and the row
badges disappear and everything else keeps working.

## Limits

- Text only. Attachments and images cannot be broadcast.
- The dialog keeps its draft for the current page only; closing the app
  discards it.
- Session visibility follows the Client Session Controller: a session the
  signed-in profile cannot list cannot be targeted.
- Delivery acceptance means the Host queued the message, not that the session
  has finished acting on it.

## Development

`pnpm install` in this directory, then `pnpm test` runs the jsdom harness. It
loads the shipped `client.js` with a stubbed module loader, session catalog, and
Session Controller, and drives the real dialog: catalog rows and tags,
filtering, selection, queued delivery, per-target failures, and retrying only
the failures.


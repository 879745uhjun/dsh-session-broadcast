/**
 * dsh-session-broadcast — Host half.
 *
 * The feature lives entirely in the browser: the Client Session Controller
 * already exposes every session it is allowed to read, and `session.prompt`
 * already admits a queued user message for any of them. A Host route or tool
 * would duplicate that admission path, so this half only keeps the bundle
 * loadable and declares the plugin name.
 *
 * The browser half is `client.js`; it registers one composer toolbar button and
 * one overlay dialog.
 *
 * @module dsh-session-broadcast
 */

/** Cordis plugin name; the patch inserts this row. */
export const name = 'dsh-session-broadcast'

/**
 * Activate the Host half.
 *
 * Nothing to register: see the module comment for why the operation lives in
 * the Client. The empty body keeps the row valid in Headless and TUI
 * compositions, where the browser half never loads.
 */
export function apply() {}

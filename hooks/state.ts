// Shared state the hooks and the pane read. The atoms stay in register.ts: the
// engine's state scan needs each atom defined in the file that reads and writes it.
// Alerts already shown, so each fires once
export const alerted: { [key: string]: boolean } = {}

// Agents the person has cleared, so the once-a-second sync from
// $.agent.list() (which lists every agent of the session, finished ones too)
// does not bring them back. Starts over when the mod reloads.
export const hidden: { [id: string]: boolean } = {}

// Every agent id $.agent.list() has reported, refreshed each second: a tool call
// from any other id is not from an agent the engine spawned
export const listedIds: { [id: string]: boolean } = {}

// Set once, from the hooks, so they live in an object that other modules can share
export type Flags = { historyLoaded: boolean; seeded: boolean }
export const flags: Flags = { historyLoaded: false, seeded: false }

export const PANE = 'session-monitor'
export const MAX_ROWS = 60
export const MAX_LOG = 40
export const SHOW_LOG = 12
export const MAX_RUNS = 10
export const LONG_MS = 3 * 60 * 1000
export const LOOP_AT = 5
export const WARN_CACHE_MS = 60 * 1000
export const MAX_REPORT_VIEW = 9500
export const ORPHAN_MS = 20 * 1000

// The tool workers call to report their own steps, named as the model sees it
export const STEP_TOOL = 'mcp__session-monitor__step'

// The tool the main session calls to post its plan: title, phase and tasks
export const PLAN_TOOL = 'mcp__session-monitor__plan'

// Step tools from other mods that take the same done/total/note report. When
// one is installed alongside, its calls feed this pane's bar and are not
// counted as work the agent did.
export const OTHER_STEP_TOOLS = ['mcp__savvy-progress__step']

// Added to the end of a worker's prompt so it knows to report. Agent types that
// finish in a few calls, and prompts too short to be a real task, are left alone.
export const STEP_BRIEF =
  '\n\nSession monitor: once you have planned this task, call ' + STEP_TOOL + ' with total set to the number of steps ' +
  '(3 to 8) and done: 0. After each step, call it again with the new done count. It only moves your bar in the monitor.'
export const STEP_SKIP_TYPES = ['Explore', 'Plan']
export const STEP_MIN_PROMPT = 200

// The prompt cache keeps an entry for about five minutes after its last use,
// and every request that reads it starts the five minutes again. Claude Code
// does not report the real lifetime, so the countdown assumes five minutes.
export const CACHE_TTL_MS = 5 * 60 * 1000

export const CONVO_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const CONVO_MAX_SHOWN = 12
export const CONVO_WORKING_MS = 45 * 1000
export const CONVO_TITLE_EVERY_MS = 30 * 1000

export const CACHE_TTL_1H_MS = 60 * 60 * 1000
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
export const CACHE_LOOKBACK = 400

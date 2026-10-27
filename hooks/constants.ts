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

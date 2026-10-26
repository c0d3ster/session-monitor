export type LogEntry = {
  // Milliseconds after the agent started
  at: number
  tool: string
  detail: string
}

export type AgentRow = {
  id: string
  name: string
  type: string
  status: string
  tools: number
  last: string
  startedAt: number
  endedAt?: number
  parentId?: string
  // Tokens this agent has used: new input (uncached + cache writes), output,
  // and input served from the prompt cache
  tokIn: number
  tokOut: number
  tokCache: number
  // What the agent was asked to do, what it did, and what it reported back
  task?: string
  log: LogEntry[]
  // How many times it used each tool (the log keeps only the latest calls)
  byTool?: { [tool: string]: number }
  result?: string
  // The model it runs on (as spawned), and an estimate of what it has cost
  model?: string
  usd?: number
  // Tool calls that came back as errors, and the latest error
  errors?: number
  lastError?: string
  // How many times in a row it made the same tool call
  repeat?: number
}

// The agents of one finished run, kept for the report
export type RunRecord = {
  at: number
  prompt: string
  agents: AgentRow[]
}

export type SessionRow = {
  // Whole-session token totals, summed from every model request
  tokIn: number
  tokOut: number
  tokCache: number
  // The main session's latest model request: input it paid full price for
  // (uncached), input written to the prompt cache, input read from it, and
  // when it finished
  lastUncached?: number
  lastCacheWrite?: number
  lastCacheRead?: number
  lastAt?: number
  // Live context window of the main session
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow?: number
  // Session cost so far, when the host keeps a ledger
  usd?: number
  // Usage limit windows as the last response reported them (5 hour, week,
  // spend): percent used and when each resets. Empty off a subscription.
  limits?: Array<{ kind: string; pct: number; resetsAt?: number }>
  // The prompt that started the current run, and when
  runPrompt?: string
  runAt?: number
  // Model responses seen, and how many of them carried token counts
  steps?: number
  usageSeen?: number
}

// How many tool calls agents of each type made, over the runs seen: the
// progress estimate learns from it
export type StatsRow = { [type: string]: { n: number; calls: number } }

export type ViewRow = {
  // The agent whose activity is expanded in the pane, if any
  openId?: string
  // The other chat (by session id) whose details are expanded, if any
  openChat?: string
  // The background job whose Stop button has been pressed once and awaits a second press
  confirmStop?: string
  // 'agents' (from /agent-monitor) hides limits, cache figures and other chats
  scope?: 'agents'
  // 'report' shows the report in place of the live view
  mode?: 'report'
  // The last thing the report view did (where it saved to)
  note?: string
  // Live view filter, and a search over names, tasks and tool calls
  filter?: 'running' | 'failed'
  query?: string
  // Hides the prompt-cache figures of the other chats
  hideCache?: boolean
  // Lists the idle chats that still have a live cache
  showIdle?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': { agents: AgentRow[]; session: SessionRow; view: ViewRow; runs: RunRecord[]; stats: StatsRow }
  }
}

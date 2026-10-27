import type { AgentRow, SessionRow, StatsRow } from '../types'
import { MAX_LOG, MAX_ROWS } from './constants'
import { seconds } from './format'
import { hidden } from './state'
import { num } from './util'

// Estimated prices in dollars per million tokens. Claude Code does not report
// what an agent cost, so per-agent cost is calculated from these and is an
// estimate. Cache reads are billed at 0.1x input, cache writes at 1.25x.
export const RATES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /opus/i, input: 5, output: 25 },
  { match: /sonnet/i, input: 3, output: 15 },
]

export const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path']

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// What one model request cost, from the model name; unknown models are priced
// like Sonnet
export function costOf(model: string | undefined, u: Usage): number {
  let rate = { input: 3, output: 15 }
  for (const candidate of RATES) {
    if (model && candidate.match.test(model)) {
      rate = candidate
      break
    }
  }
  const perToken = 1 / 1000000
  return (
    (num(u.input_tokens) * rate.input +
      num(u.cache_creation_input_tokens) * rate.input * 1.25 +
      num(u.cache_read_input_tokens) * rate.input * 0.1 +
      num(u.output_tokens) * rate.output) *
    perToken
  )
}

// A short description of what a tool call is about, taken from its arguments
export function summarize(e: Record<string, unknown>): string {
  for (const key of ARG_KEYS) {
    const value = e[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  return ''
}

export function blank(id: string): AgentRow {
  return {
    id,
    name: id === 'main' ? 'main session' : id.slice(0, 8),
    type: id === 'main' ? 'main' : 'agent',
    status: id === 'main' ? 'idle' : 'running',
    tools: 0,
    last: '',
    startedAt: Date.now(),
    tokIn: 0,
    tokOut: 0,
    tokCache: 0,
    log: [],
  }
}

// Adds a row for `id` if there isn't one, then applies `patch` to it
export function upsert(list: AgentRow[], id: string, patch: Partial<AgentRow>): AgentRow[] {
  let found = false
  const out = list.map(row => {
    if (row.id !== id) return row
    found = true
    return Object.assign({}, row, patch)
  })
  if (!found) out.push(Object.assign(blank(id), patch))
  return out.slice(-MAX_ROWS)
}

// Counts one tool call against `id` and adds it to that agent's log
export function bumpTool(list: AgentRow[], id: string, tool: string, detail: string): AgentRow[] {
  const existing = list.filter(row => row.id === id)[0]
  const base = existing || blank(id)
  const entry = { at: Math.max(0, Date.now() - base.startedAt), tool, detail }
  const byTool = Object.assign({}, base.byTool || {})
  byTool[tool] = (byTool[tool] || 0) + 1
  const what = tool + (detail ? ' ' + detail : '')
  const patch: Partial<AgentRow> = {
    tools: base.tools + 1,
    repeat: base.last === what ? num(base.repeat) + 1 : 1,
    last: what,
    log: base.log.concat([entry]).slice(-MAX_LOG),
    byTool,
  }
  if (id === 'main') {
    patch.status = 'running'
  } else if (!existing || existing.status !== 'running') {
    patch.status = 'running'
    patch.endedAt = undefined
  }
  return upsert(list, id, patch)
}

// Adds one model request's token counts to the agent that made it
export function addTokens(list: AgentRow[], id: string, u: Usage): AgentRow[] {
  const base = list.filter(row => row.id === id)[0] || blank(id)
  return upsert(list, id, {
    usd: id === 'main' ? undefined : num(base.usd) + costOf(base.model, u),
    tokIn: num(base.tokIn) + num(u.input_tokens) + num(u.cache_creation_input_tokens),
    tokOut: num(base.tokOut) + num(u.output_tokens),
    tokCache: num(base.tokCache) + num(u.cache_read_input_tokens),
  })
}

export function addSession(s: SessionRow, u: Usage, isMain: boolean): SessionRow {
  const next = Object.assign({}, s, {
    steps: num(s.steps) + 1,
    usageSeen: num(s.usageSeen) + 1,
    tokIn: num(s.tokIn) + num(u.input_tokens) + num(u.cache_creation_input_tokens),
    tokOut: num(s.tokOut) + num(u.output_tokens),
    tokCache: num(s.tokCache) + num(u.cache_read_input_tokens),
  })
  // The cache figures describe the context window, which is the main loop's
  if (isMain) {
    next.lastUncached = num(u.input_tokens)
    next.lastCacheWrite = num(u.cache_creation_input_tokens)
    next.lastCacheRead = num(u.cache_read_input_tokens)
    next.lastAt = Date.now()
  }
  return next
}

// Brings the rows in line with what $.agent.list() says
export function merge(
  list: AgentRow[],
  infos: Array<{ id: string; description: string; type: string; status: string; parentId?: string; name?: string }>,
): AgentRow[] {
  let out = list
  infos.forEach(info => {
    const before = out.filter(row => row.id === info.id)[0]
    const patch: Partial<AgentRow> = {
      name: info.name || info.description || info.id.slice(0, 8),
      type: info.type,
      status: info.status,
      parentId: info.parentId,
    }
    if (info.status !== 'running' && (!before || before.endedAt === undefined)) {
      patch.endedAt = Date.now()
    }
    out = upsert(out, info.id, patch)
  })
  return out
}

// Drops every agent that is not running (the main session stays), and
// remembers them so the sync does not bring them back
export function dismissFinished(list: AgentRow[]): AgentRow[] {
  return list.filter(row => {
    const keep = row.id === 'main' || row.status === 'running'
    if (!keep) hidden[row.id] = true
    return keep
  })
}

export function elapsed(row: AgentRow): string {
  const end = row.endedAt === undefined ? Date.now() : row.endedAt
  return seconds(end - row.startedAt)
}

export function isDone(status: string): boolean {
  return status === 'completed' || status === 'done'
}

export function isFailed(status: string): boolean {
  return status !== 'running' && status !== 'idle' && !isDone(status)
}

export function statusWord(status: string): string {
  if (isDone(status)) return 'done'
  if (status === 'killed') return 'stopped'
  if (status === 'failed') return 'failed'
  return status
}

export function marker(status: string): string {
  if (status === 'running') return '●'
  if (status === 'idle') return '○'
  if (isDone(status)) return '✓'
  return '✗'
}

export function colorOf(status: string): string | undefined {
  if (status === 'running') return 'cyan'
  if (isDone(status)) return 'green'
  if (status === 'idle') return undefined
  return 'red'
}

// Claude Code does not report how far through its work an agent is, so a
// running agent's progress is an estimate from its tool calls: quick at first,
// flattening out, and held under 95% until the agent actually finishes.
// Once two or more agents of the same type have finished, it uses how many
// calls they averaged instead.
export function learnedCalls(row: AgentRow, history: StatsRow): number {
  const entry = history[row.type]
  return entry && entry.n >= 2 ? entry.calls / entry.n : 0
}

export function progressOf(row: AgentRow, history: StatsRow): number {
  if (isDone(row.status)) return 100
  const expected = learnedCalls(row, history)
  if (expected > 0) return Math.min(95, Math.round((100 * num(row.tools)) / Math.max(1, expected)))
  return Math.min(95, Math.round(100 * (1 - Math.exp(-num(row.tools) / 10))))
}

// Parents first, each followed by its children, with the depth of each row
export function ordered(list: AgentRow[]): Array<{ row: AgentRow; depth: number }> {
  const ids: { [id: string]: boolean } = {}
  list.forEach(row => {
    ids[row.id] = true
  })
  const out: Array<{ row: AgentRow; depth: number }> = []
  const seen: { [id: string]: boolean } = {}
  const walk = (row: AgentRow, depth: number) => {
    if (seen[row.id]) return
    seen[row.id] = true
    out.push({ row, depth })
    list.filter(child => child.parentId === row.id).forEach(child => walk(child, Math.min(depth + 1, 3)))
  }
  list
    .filter(row => !row.parentId || !ids[row.parentId])
    .sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.startedAt - b.startedAt))
    .forEach(row => walk(row, 0))
  list.forEach(row => walk(row, 0))
  return out
}

// An agent's own tokens plus those of every agent it started
export function rollup(list: AgentRow[], row: AgentRow): { tokIn: number; tokOut: number; usd: number; kids: number } {
  const total = { tokIn: num(row.tokIn), tokOut: num(row.tokOut), usd: num(row.usd), kids: 0 }
  const seen: { [id: string]: boolean } = {}
  seen[row.id] = true
  const walk = (parent: string) => {
    list
      .filter(child => child.parentId === parent && !seen[child.id])
      .forEach(child => {
        seen[child.id] = true
        total.tokIn += num(child.tokIn)
        total.tokOut += num(child.tokOut)
        total.usd += num(child.usd)
        total.kids += 1
        walk(child.id)
      })
  }
  walk(row.id)
  return total
}

// Does the search text appear in the agent's name, type, task, result or any
// of its recent tool calls?
export function matches(row: AgentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [row.name, row.type, row.task || '', row.result || '', row.last]
    .concat(row.log.map(entry => entry.tool + ' ' + entry.detail))
    .join('\n')
    .toLowerCase()
  return hay.indexOf(q) >= 0
}

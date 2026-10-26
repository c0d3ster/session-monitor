import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, RunRecord, SessionRow, StatsRow, ViewRow } from '../types'

// Written in an ES2017 (ES8) style where it can be: no object spread, no
// optional chaining, no nullish coalescing. The one exception is the
// `turn.step` hook, which Claude Code requires to be an async generator.

const PANE = 'session-monitor'
const MAX_ROWS = 60
const MAX_LOG = 40
const SHOW_LOG = 12
const MAX_RUNS = 10
const LONG_MS = 3 * 60 * 1000
const LOOP_AT = 5
const WARN_CACHE_MS = 60 * 1000
const MAX_REPORT_VIEW = 9500
const ORPHAN_MS = 20 * 1000

// The prompt cache keeps an entry for about five minutes after its last use,
// and every request that reads it starts the five minutes again. Claude Code
// does not report the real lifetime, so the countdown assumes five minutes.
const CACHE_TTL_MS = 5 * 60 * 1000

const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [] as AgentRow[])
const session = atom(
  { plugin: 'session-monitor', key: 'session' } as const,
  { tokIn: 0, tokOut: 0, tokCache: 0 } as SessionRow,
)
const view = atom({ plugin: 'session-monitor', key: 'view' } as const, {} as ViewRow)
const runs = atom({ plugin: 'session-monitor', key: 'runs' } as const, [] as RunRecord[])
const stats = atom({ plugin: 'session-monitor', key: 'stats' } as const, {} as StatsRow)

// Alerts already shown, so each fires once
const alerted: { [key: string]: boolean } = {}
let historyLoaded = false

// Estimated prices in dollars per million tokens. Claude Code does not report
// what an agent cost, so per-agent cost is calculated from these and is an
// estimate. Cache reads are billed at 0.1x input, cache writes at 1.25x.
const RATES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /opus/i, input: 5, output: 25 },
  { match: /sonnet/i, input: 3, output: 15 },
]

// Agents the person has cleared, so the once-a-second sync from
// $.agent.list() (which lists every agent of the session, finished ones too)
// does not bring them back. Starts over when the mod reloads.
const hidden: { [id: string]: boolean } = {}

// Every agent id $.agent.list() has reported, refreshed each second: a tool call
// from any other id is not from an agent the engine spawned
const listedIds: { [id: string]: boolean } = {}
let seeded = false

const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path']

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// A usable count: a number that is not NaN or infinite, else 0
function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) ? x : 0
}

// What one model request cost, from the model name; unknown models are priced
// like Sonnet
function costOf(model: string | undefined, u: Usage): number {
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
function summarize(e: Record<string, unknown>): string {
  for (const key of ARG_KEYS) {
    const value = e[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  return ''
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function blank(id: string): AgentRow {
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
function upsert(list: AgentRow[], id: string, patch: Partial<AgentRow>): AgentRow[] {
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
function bumpTool(list: AgentRow[], id: string, tool: string, detail: string): AgentRow[] {
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
function addTokens(list: AgentRow[], id: string, u: Usage): AgentRow[] {
  const base = list.filter(row => row.id === id)[0] || blank(id)
  return upsert(list, id, {
    usd: id === 'main' ? undefined : num(base.usd) + costOf(base.model, u),
    tokIn: num(base.tokIn) + num(u.input_tokens) + num(u.cache_creation_input_tokens),
    tokOut: num(base.tokOut) + num(u.output_tokens),
    tokCache: num(base.tokCache) + num(u.cache_read_input_tokens),
  })
}

function addSession(s: SessionRow, u: Usage, isMain: boolean): SessionRow {
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
function merge(
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
function dismissFinished(list: AgentRow[]): AgentRow[] {
  return list.filter(row => {
    const keep = row.id === 'main' || row.status === 'running'
    if (!keep) hidden[row.id] = true
    return keep
  })
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function seconds(ms: number): string {
  const secs = Math.max(0, Math.round(num(ms) / 1000))
  if (secs < 60) return secs + 's'
  return Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's'
}

function elapsed(row: AgentRow): string {
  const end = row.endedAt === undefined ? Date.now() : row.endedAt
  return seconds(end - row.startedAt)
}

function isDone(status: string): boolean {
  return status === 'completed' || status === 'done'
}

function isFailed(status: string): boolean {
  return status !== 'running' && status !== 'idle' && !isDone(status)
}

function statusWord(status: string): string {
  if (isDone(status)) return 'done'
  if (status === 'killed') return 'stopped'
  if (status === 'failed') return 'failed'
  return status
}

function marker(status: string): string {
  if (status === 'running') return '●'
  if (status === 'idle') return '○'
  if (isDone(status)) return '✓'
  return '✗'
}

function colorOf(status: string): string | undefined {
  if (status === 'running') return 'cyan'
  if (isDone(status)) return 'green'
  if (status === 'idle') return undefined
  return 'red'
}

// 1234 -> 1.2k, 56789 -> 57k, 1234567 -> 1.2M; anything unusable -> a dash
function fmt(n: number): string {
  if (typeof n !== 'number' || !isFinite(n)) return '–'
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  if (n < 1000000) return Math.round(n / 1000) + 'k'
  return (n / 1000000).toFixed(1) + 'M'
}

// "in 12k · out 3.1k · total 15k", or dashes while nothing has been reported
function tokenLine(tokIn: number, tokOut: number): string {
  const i = num(tokIn)
  const o = num(tokOut)
  if (i + o === 0) return 'in – · out – · total –'
  return 'in ' + fmt(i) + ' · out ' + fmt(o) + ' · total ' + fmt(i + o)
}

function money(usd: number): string {
  return '$' + (usd < 10 ? usd.toFixed(2) : usd.toFixed(1))
}

function cut(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : text.slice(0, width - 1) + '…'
}

function two(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Time left until a moment, as short as it can be: 2d3h, 1h42m, 7m
function untilText(ms: number): string {
  const mins = Math.max(0, Math.round(num(ms) / 60000))
  if (mins >= 1440) return Math.floor(mins / 1440) + 'd' + Math.floor((mins % 1440) / 60) + 'h'
  if (mins >= 60) return Math.floor(mins / 60) + 'h' + two(mins % 60) + 'm'
  return mins + 'm'
}

// The local clock time of a moment: 6:30am, and the weekday when it is not today
function clockText(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const time = (h % 12 === 0 ? 12 : h % 12) + ':' + two(d.getMinutes()) + (h < 12 ? 'am' : 'pm')
  return d.toDateString() === new Date().toDateString() ? time : DAYS[d.getDay()] + ' ' + time
}

const LIMIT_NAMES: { [kind: string]: string } = { five_hour: '5h limit', seven_day: 'week limit', spend_limit: 'spend limit' }

// What the last scan of every transcript on this machine put each usage window
// at, in dollars at list prices. Worked out by scripts/window-cost.cjs, which
// streams the files, so a transcript over the 4 MiB read limit counts too.
const PLAN_COST_EVERY_MS = 60 * 1000
const planCost: { usd: { [kind: string]: number }; at: number; running: boolean; error: string } = { usd: {}, at: 0, running: false, error: '' }

// 14:05
function clock(ms: number): string {
  const d = new Date(ms)
  return two(d.getHours()) + ':' + two(d.getMinutes())
}

// 20261007-140532, for file names
function fileStamp(ms: number): string {
  const d = new Date(ms)
  return (
    String(d.getFullYear()) +
    two(d.getMonth() + 1) +
    two(d.getDate()) +
    '-' +
    two(d.getHours()) +
    two(d.getMinutes()) +
    two(d.getSeconds())
  )
}

// Claude Code does not report how far through its work an agent is, so a
// running agent's progress is an estimate from its tool calls: quick at first,
// flattening out, and held under 95% until the agent actually finishes.
// Once two or more agents of the same type have finished, it uses how many
// calls they averaged instead.
function learnedCalls(row: AgentRow, history: StatsRow): number {
  const entry = history[row.type]
  return entry && entry.n >= 2 ? entry.calls / entry.n : 0
}

function progressOf(row: AgentRow, history: StatsRow): number {
  if (isDone(row.status)) return 100
  const expected = learnedCalls(row, history)
  if (expected > 0) return Math.min(95, Math.round((100 * num(row.tools)) / Math.max(1, expected)))
  return Math.min(95, Math.round(100 * (1 - Math.exp(-num(row.tools) / 10))))
}

function bar(percent: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round((num(percent) / 100) * width)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

// Parents first, each followed by its children, with the depth of each row
function ordered(list: AgentRow[]): Array<{ row: AgentRow; depth: number }> {
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
function rollup(list: AgentRow[], row: AgentRow): { tokIn: number; tokOut: number; usd: number; kids: number } {
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
function matches(row: AgentRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [row.name, row.type, row.task || '', row.result || '', row.last]
    .concat(row.log.map(entry => entry.tool + ' ' + entry.detail))
    .join('\n')
    .toLowerCase()
  return hay.indexOf(q) >= 0
}

function costText(usd: number | undefined): string {
  return usd === undefined ? '–' : '~' + money(usd)
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function toolCounts(row: AgentRow): string {
  const counts = row.byTool || {}
  return Object.keys(counts)
    .sort((a, b) => num(counts[b]) - num(counts[a]))
    .map(tool => tool + ' ×' + counts[tool])
    .join(' · ')
}

// One run as markdown: a table of its agents, then what each one did
function runSection(rows: AgentRow[]): string[] {
  const lines: string[] = []
  const list = ordered(rows)
  if (list.length === 0) return ['_No agent activity._', '']

  lines.push('| Agent | Type | Status | Time | Calls | Errors | In | Out | Total | Cost |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  list.forEach(item => {
    const row = item.row
    const total = num(row.tokIn) + num(row.tokOut)
    const status = row.id === 'main' ? row.status : statusWord(row.status)
    lines.push(
      '| ' +
        [
          '  '.repeat(item.depth) + row.name,
          row.type + (row.model ? ' (' + row.model + ')' : ''),
          status,
          elapsed(row),
          row.tools,
          num(row.errors),
          total ? fmt(row.tokIn) : '–',
          total ? fmt(row.tokOut) : '–',
          total ? fmt(total) : '–',
          costText(row.usd),
        ].join(' | ') +
        ' |',
    )
  })
  lines.push('')

  list.forEach(item => {
    const row = item.row
    if (row.tools === 0 && !row.task && !row.result) return
    const status = row.id === 'main' ? row.status : statusWord(row.status)
    lines.push('### ' + row.name)
    lines.push('_' + row.type + ' · ' + status + ' · ' + elapsed(row) + ' · ' + tokenLine(row.tokIn, row.tokOut) + '_')
    lines.push('')
    if (row.task) lines.push('**Task:** ' + row.task, '')
    const counts = toolCounts(row)
    if (counts) lines.push('**Tools:** ' + counts, '')
    if (num(row.errors) > 0) lines.push('**Errors:** ' + row.errors + (row.lastError ? ' · last: ' + row.lastError : ''), '')
    if (row.log.length > 0) {
      lines.push('**Actions:**')
      if (row.tools > row.log.length) lines.push('- … ' + (row.tools - row.log.length) + ' earlier calls not shown')
      row.log.forEach(entry => {
        lines.push('- `+' + seconds(entry.at) + '` **' + entry.tool + '**' + (entry.detail ? ' ' + entry.detail : ''))
      })
      lines.push('')
    }
    if (row.result) lines.push('**Result:** ' + row.result, '')
  })
  return lines
}

type RunStat = { at: number; prompt: string; agents: number; calls: number; tokens: number; usd: number; ms: number }

function statOf(at: number, prompt: string, rows: AgentRow[]): RunStat {
  let start = 0
  let end = 0
  const out = { at, prompt, agents: 0, calls: 0, tokens: 0, usd: 0, ms: 0 }
  rows.forEach(row => {
    if (row.id !== 'main') out.agents += 1
    out.calls += num(row.tools)
    out.tokens += num(row.tokIn) + num(row.tokOut)
    out.usd += num(row.usd)
    const rowEnd = row.endedAt === undefined ? row.startedAt : row.endedAt
    if (start === 0 || row.startedAt < start) start = row.startedAt
    if (rowEnd > end) end = rowEnd
  })
  out.ms = end > start ? end - start : 0
  return out
}

// All runs side by side, newest first
function comparison(rows: AgentRow[], history: RunRecord[], s: SessionRow): string[] {
  const all: RunStat[] = [statOf(s.runAt || 0, s.runPrompt || '', rows)].concat(
    history
      .slice()
      .reverse()
      .map(record => statOf(record.at, record.prompt, record.agents)),
  )
  if (all.length < 2) return []
  const lines = ['## Runs compared', '', '| Run | Prompt | Agents | Calls | Tokens | Cost | Duration |', '| --- | --- | --- | --- | --- | --- | --- |']
  all.forEach((r, i) => {
    lines.push(
      '| ' +
        [
          i === 0 ? 'this run' : r.at ? clock(r.at) : '–',
          r.prompt ? cut(r.prompt.replace(/\|/g, '/'), 40) : '–',
          r.agents,
          r.calls,
          fmt(r.tokens),
          r.usd > 0 ? '~' + money(r.usd) : '–',
          r.ms > 0 ? seconds(r.ms) : '–',
        ].join(' | ') +
        ' |',
    )
  })
  lines.push('')
  return lines
}

function reportsDir(home: string | undefined, cwd: string): string {
  return (home || cwd) + '/.claude/agent-reports'
}

function historyText(history: RunRecord[], learned: StatsRow): string {
  return JSON.stringify({ runs: history, stats: learned })
}

function csvCell(value: unknown): string {
  const text = String(value === undefined ? '' : value)
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

// Every agent of every run, one row each
function buildCsv(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
  const out = ['run,started,agent,type,model,status,seconds,calls,errors,tokens_in,tokens_out,tokens_total,est_usd']
  const add = (label: string, at: number, list: AgentRow[]) => {
    list.forEach(row => {
      const end = row.endedAt === undefined ? Date.now() : row.endedAt
      out.push(
        [
          label,
          at ? new Date(at).toISOString() : '',
          row.name,
          row.type,
          row.model || '',
          row.status,
          Math.round((end - row.startedAt) / 1000),
          row.tools,
          num(row.errors),
          num(row.tokIn),
          num(row.tokOut),
          num(row.tokIn) + num(row.tokOut),
          row.usd === undefined ? '' : row.usd.toFixed(4),
        ]
          .map(csvCell)
          .join(','),
      )
    })
  }
  add('this run', s.runAt || 0, rows)
  history
    .slice()
    .reverse()
    .forEach((record, i) => add('earlier ' + (i + 1), record.at, record.agents))
  return out.join('\n')
}

function buildJson(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
  return JSON.stringify(
    {
      generated: new Date().toISOString(),
      session: s,
      runs: [{ at: s.runAt || 0, prompt: s.runPrompt || '', agents: rows }].concat(history.slice().reverse()),
    },
    null,
    2,
  )
}

function buildReport(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
  const lines: string[] = ['# Agent report', '']
  lines.push(
    'Generated ' + clock(Date.now()) + (s.usd !== undefined ? ' · session cost ' + money(s.usd) : ''),
    '',
    'Session tokens: ' +
      tokenLine(s.tokIn, s.tokOut) +
      (num(s.tokCache) > 0 ? ' · cached ' + fmt(s.tokCache) : ''),
    '',
    '_Per-agent cost is an estimate from list prices; token counts come from ' +
      num(s.usageSeen) +
      ' of ' +
      Math.max(num(s.steps), num(s.usageSeen)) +
      ' model responses._',
    '',
  )
  comparison(rows, history, s).forEach(line => lines.push(line))

  lines.push('## This run' + (s.runAt ? ' · ' + clock(s.runAt) : ''), '')
  if (s.runPrompt) lines.push('> ' + s.runPrompt, '')
  runSection(rows).forEach(line => lines.push(line))

  history
    .slice()
    .reverse()
    .forEach(record => {
      lines.push('## Earlier run' + (record.at ? ' · ' + clock(record.at) : ''), '')
      if (record.prompt) lines.push('> ' + record.prompt, '')
      runSection(record.agents).forEach(line => lines.push(line))
    })

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Other conversations: every session writes a transcript under
// ~/.claude/projects, so its recent writes show which chats are working
// ---------------------------------------------------------------------------

type Convo = {
  id: string
  title: string
  mtimeMs: number
  mine: boolean
  working: number
  tools: number
  lastTool: string
}

const CONVO_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CONVO_MAX_SHOWN = 12
const CONVO_WORKING_MS = 45 * 1000
const CONVO_TITLE_EVERY_MS = 30 * 1000

let convos: Convo[] = []
let lastConvoScan = 0
let convoError = ''
let convoScans = 0
const convoTitles: Record<string, { title: string; size: number; at: number; tools: number; lastTool: string }> = {}

// A session the agents panel lists, read from ~/.claude/sessions and, for a
// background job, ~/.claude/jobs/<id>/state.json
type Live = {
  id: string
  // The process id: the session file is named for it
  pid: number
  name: string
  cwd: string
  kind: string
  busy: boolean
  startedAt: number
  since: number
  detail: string
  tokens: number
  tasks: number
  // A pre-warmed background worker nobody has given work, and a helper that
  // waits for a Remote Control prompt: neither has a transcript to read
  spare: boolean
  remote: boolean
  // The name of the background job this chat handed its work to, if it did.
  // The chat keeps the status it had when it handed off, so it must not count
  // as working.
  handedTo: string
  // The background job this session is, when it is one: `claude attach` takes it
  jobId: string
  // What a background job says it is waiting on (its state.json `needs`), or empty
  needs: string
}

let liveSessions: Live[] = []
let liveMine = ''

// What a chat's latest model request says about its prompt cache, read from
// its transcript. `ttlMs` is the lifetime the request's cache write used (1 hour
// or 5 minutes); `ttlKnown` is false when no recent write says, and the
// five-minute default stands in.
type CacheInfo = {
  ctxTokens: number
  read: number
  wrote: number
  fresh: number
  hitPct: number
  lastAt: number
  ttlMs: number
  ttlKnown: boolean
}

type LiveExtra = {
  tools: number
  lastTool: string
  subs: number
  at: number
  note: string
  tokIn: number
  tokOut: number
  usd: number
  // Tool calls since the latest prompt: the progress estimate counts from it
  turnTools: number
  // Transcript size when last read: an unchanged file is not read again
  size: number
  // Whether the transcript file exists at all
  exists: boolean
  // Over the read limit: the size scripts/big-transcript.cjs last read from the
  // end of the file, and why it could not, if it could not
  bigSize?: number
  bigError?: string
  // Lifetime tool calls counted so far in a big transcript, and the byte offset
  // that count covers: the next read counts only what was added after it
  bigToolsAt?: number
  // The latest prompt typed in the chat, cut short
  lastPrompt?: string
  // When the transcript file last changed: a chat whose session file still says
  // idle (a background job's does) is working if its transcript is being written
  mtimeMs?: number
  cache?: CacheInfo
}

const liveExtra: Record<string, LiveExtra> = {}

// Whether a window was found for a chat the last time it was looked for: a chat
// whose terminal was closed, or a job nothing is showing, has none to raise
const focusProbe: Record<string, { ok: boolean; at: number }> = {}

// Working: the session file says so, or the transcript changed a moment ago. A
// chat that handed its work to a background job is not, whatever it last said.
const isBusy = (l: Live, now: number): boolean => {
  if (l.handedTo !== '') return false
  if (l.busy) return true
  const changed = liveExtra[l.id]?.mtimeMs ?? 0
  return changed > 0 && now - changed < CONVO_WORKING_MS
}

const subsOf = (id: string): number => liveExtra[id]?.subs ?? 0
const usdOf = (id: string): number => liveExtra[id]?.usd ?? 0

const CACHE_TTL_1H_MS = 60 * 60 * 1000
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const CACHE_LOOKBACK = 400

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const parseJson = (text: unknown): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(String(text))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const toolStats = (text: string): { tools: number; lastTool: string } => {
  const mark = '"type":"tool_use"'
  const tools = text.split(mark).length - 1
  const at = text.lastIndexOf(mark)
  if (at < 0) return { tools: 0, lastTool: '' }
  const after = text.slice(at, at + 400)
  const found = after.match(/"name":"([^"]*)"/)
  return { tools, lastTool: found ? str(found[1]) : '' }
}

// The latest prompt the person typed, for the chat details: the last user line
// that is not a tool result. A slash command reads as the command and its
// arguments; reminders and tags are dropped. Shown, never logged or stored.
const promptText = (entry: Record<string, unknown>): string => {
  const message = isRecord(entry.message) ? entry.message : undefined
  if (!message || entry.isMeta === true) return ''
  const content = message.content
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => (isRecord(block) && block.type === 'text' ? str(block.text) : '')).join(' ')
        : ''
  const command = /<command-name>([^<]*)<\/command-name>/.exec(raw)
  const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)
  if (command) return ((command[1] || '') + ' ' + (args ? args[1] || '' : '')).trim()
  return raw
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

const latestPrompt = (text: string): string => {
  const lines = text.split(String.fromCharCode(10))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] || ''
    if (line.indexOf('"type":"user"') < 0 || line.indexOf('tool_result') >= 0 || line.length > 200000) continue
    const entry = parseJson(line)
    const said = entry ? promptText(entry) : ''
    if (said) return said
  }
  return ''
}

// Tool calls made since the latest prompt the person typed: a prompt is a user
// line that is not a tool result. Walks back from the end and stops there.
const turnTools = (text: string): number => {
  const lines = text.split(String.fromCharCode(10))
  let count = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] || ''
    if (line.indexOf('"type":"user"') >= 0 && line.indexOf('tool_result') < 0) break
    count += line.split('"type":"tool_use"').length - 1
  }
  return count
}

// Progress of a chat's current turn, from its tool calls: the same curve a
// subagent uses before it has history, held under 95%
const turnProgress = (calls: number): number => Math.min(95, Math.round(100 * (1 - Math.exp(-num(calls) / 10))))

// Tokens and estimated cost for a whole transcript, summed from each reply's
// usage block. A reply can be written to the file more than once while it
// streams, so the last usage seen for each message id is the one counted.
const usageStats = (text: string): { tokIn: number; tokOut: number; usd: number } => {
  const byMessage: Record<string, { model: string; usage: Usage }> = {}
  const lines = text.split(String.fromCharCode(10))
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || ''
    if (line.indexOf('"usage"') < 0) continue
    const entry = parseJson(line)
    const message = entry && isRecord(entry.message) ? entry.message : undefined
    if (!message || !isRecord(message.usage)) continue
    const u = message.usage
    byMessage[str(message.id) || 'line-' + i] = {
      model: str(message.model),
      usage: {
        input_tokens: num(u.input_tokens),
        output_tokens: num(u.output_tokens),
        cache_read_input_tokens: num(u.cache_read_input_tokens),
        cache_creation_input_tokens: num(u.cache_creation_input_tokens),
      },
    }
  }
  const total = { tokIn: 0, tokOut: 0, usd: 0 }
  Object.keys(byMessage).forEach(key => {
    const entry = byMessage[key]
    if (!entry) return
    const { model, usage } = entry
    total.tokIn += num(usage.input_tokens) + num(usage.cache_creation_input_tokens)
    total.tokOut += num(usage.output_tokens)
    total.usd += costOf(model, usage)
  })
  return total
}

// The prompt cache as of a transcript's latest model request, walking back
// from the end. The lifetime comes from the newest request that wrote to the
// cache: its `cache_creation` block splits the write into 1 hour and 5 minute
// entries. A request that only read the cache says nothing about it.
const cacheStats = (text: string): CacheInfo | undefined => {
  const lines = text.split(String.fromCharCode(10))
  let info: CacheInfo | undefined
  let ttlMs = 0
  let seen = 0
  for (let i = lines.length - 1; i >= 0 && seen < CACHE_LOOKBACK; i -= 1) {
    const line = lines[i] || ''
    if (line.indexOf('"usage"') < 0) continue
    const entry = parseJson(line)
    const message = entry && isRecord(entry.message) ? entry.message : undefined
    if (!entry || !message || !isRecord(message.usage)) continue
    seen += 1
    const u = message.usage
    if (!info) {
      const at = Date.parse(str(entry.timestamp))
      if (isFinite(at)) {
        const read = num(u.cache_read_input_tokens)
        const wrote = num(u.cache_creation_input_tokens)
        const fresh = num(u.input_tokens)
        const total = read + wrote + fresh
        if (total > 0) {
          info = {
            ctxTokens: total,
            read,
            wrote,
            fresh,
            hitPct: Math.round((read / total) * 100),
            lastAt: at,
            ttlMs: CACHE_TTL_MS,
            ttlKnown: false,
          }
        }
      }
    }
    if (ttlMs === 0 && isRecord(u.cache_creation)) {
      if (num(u.cache_creation.ephemeral_1h_input_tokens) > 0) ttlMs = CACHE_TTL_1H_MS
      else if (num(u.cache_creation.ephemeral_5m_input_tokens) > 0) ttlMs = CACHE_TTL_MS
    }
    if (info && ttlMs > 0) break
  }
  if (info && ttlMs > 0) {
    info.ttlMs = ttlMs
    info.ttlKnown = true
  }
  return info
}

// How long the cache of the chat this pane runs in lasts: what its transcript
// shows, else the five-minute default
const mainTtlMs = (): number => {
  const own = liveMine ? liveExtra[liveMine] : undefined
  return own && own.cache && own.cache.ttlKnown ? own.cache.ttlMs : CACHE_TTL_MS
}

const ttlLabel = (ttlMs: number, known: boolean): string => (ttlMs >= CACHE_TTL_1H_MS ? '1h' : '5m') + (known ? '' : '?')

// What a session is doing right now, for chats that have no job file: the
// first line of its latest reply, else its latest tool call
const latestNote = (text: string): string => {
  const lines = text.split(String.fromCharCode(10))
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 60; i -= 1) {
    const line = lines[i] || ''
    if (line.indexOf('"type":"assistant"') < 0) continue
    const entry = parseJson(line)
    const message = entry && isRecord(entry.message) ? entry.message : undefined
    const content = message && Array.isArray(message.content) ? message.content : []
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block: unknown = content[j]
      if (!isRecord(block)) continue
      if (block.type === 'text' && str(block.text).trim()) return str(block.text).trim().split(String.fromCharCode(10))[0] || ''
      if (block.type === 'tool_use') {
        const input = isRecord(block.input) ? block.input : {}
        const arg = str(input.description) || str(input.command) || str(input.file_path) || str(input.pattern) || str(input.url)
        return str(block.name) + (arg ? ': ' + arg : '')
      }
    }
  }
  return ''
}

const projectLabel = (dir: string): string => {
  const parts = dir.split('-').filter(part => part.length > 0)
  return parts.length > 0 ? str(parts[parts.length - 1]) : dir
}

const titleFrom = (text: string): string | undefined => {
  const key = '"aiTitle":'
  const at = text.lastIndexOf(key)
  if (at < 0) return undefined
  const end = text.indexOf(String.fromCharCode(10), at)
  const line = text.slice(at + key.length, end < 0 ? undefined : end)
  const close = line.indexOf(',"sessionId"')
  try {
    const parsed: unknown = JSON.parse(close < 0 ? line.replace(/}\s*$/, '') : line.slice(0, close))
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-monitor',
      description: 'Open the monitor pane: this session, other chats, limits and agents',
      immediate: true,
    })
    await $.command.register({
      name: 'agent-monitor',
      description: 'Open the monitor pane with agents only',
      immediate: true,
    })
    await $.command.register({
      name: 'agent-report',
      description: 'Open a report on what the agents did',
      immediate: true,
    })

    // Earlier runs and what they taught about each agent type, saved by a
    // previous session
    if (!historyLoaded) {
      historyLoaded = true
      try {
        const home = await $.env.get('HOME')
        const text = await $.fs.read(reportsDir(home, await $.session.cwd()) + '/history.json')
        const saved = JSON.parse(String(text))
        if (saved && Array.isArray(saved.runs)) {
          await update($, runs, current => (current.length > 0 ? current : saved.runs.slice(-MAX_RUNS)))
        }
        if (saved && saved.stats && typeof saved.stats === 'object') {
          await update($, stats, current => (Object.keys(current).length > 0 ? current : saved.stats))
        }
      } catch (err) {
        // No saved history yet, or it cannot be read: start fresh
      }
    }

    // Once a minute at most, in a child process so the pane never waits on it:
    // what each usage window has cost on this machine, at list prices
    const refreshPlanCost = async (home: string): Promise<void> => {
      if (planCost.running || Date.now() - planCost.at < PLAN_COST_EVERY_MS) return
      const limits = (await read($, session)).limits || []
      const spans: { [kind: string]: number } = { five_hour: 5 * 3600000, seven_day: 7 * 24 * 3600000 }
      const windows: Array<{ name: string; start: number }> = []
      limits.forEach(l => {
        const span = spans[l.kind]
        if (span === undefined) return
        windows.push({ name: l.kind, start: (l.resetsAt === undefined ? Date.now() : l.resetsAt) - span })
      })
      if (windows.length === 0) return
      planCost.running = true
      try {
        const rates = RATES.map(r => ({ match: r.match.source, input: r.input, output: r.output }))
        const run = await $.process.run(
          ['node', $.plugin.root + '/scripts/window-cost.cjs', home + '/.claude/projects', JSON.stringify({ windows, rates })],
          { timeoutMs: 120000 },
        )
        const out = run.exitCode === 0 ? parseJson(run.stdout) : undefined
        const found = out && isRecord(out.windows) ? out.windows : undefined
        if (!found) {
          planCost.error = run.exitCode === 0 ? 'unreadable output' : oneLine(run.stderr, 80) || 'exit ' + run.exitCode
        } else {
          const usd: { [kind: string]: number } = {}
          Object.keys(found).forEach(kind => {
            const w = found[kind]
            usd[kind] = isRecord(w) ? num(w.usd) : 0
          })
          planCost.usd = usd
          planCost.error = ''
        }
      } catch (err) {
        planCost.error = oneLine(String(err), 80)
      } finally {
        planCost.at = Date.now()
        planCost.running = false
      }
    }

    // Transcripts over the read limit: a child process reads the end of each
    // (scripts/big-transcript.cjs) and the figures are folded into liveExtra.
    // Asked for again only when a file's size has changed.
    let bigRunning = false
    const cacheFrom = (v: unknown): CacheInfo | undefined => {
      if (!isRecord(v)) return undefined
      return {
        ctxTokens: num(v.ctxTokens),
        read: num(v.read),
        wrote: num(v.wrote),
        fresh: num(v.fresh),
        hitPct: num(v.hitPct),
        lastAt: num(v.lastAt),
        ttlMs: num(v.ttlMs) > 0 ? num(v.ttlMs) : CACHE_TTL_MS,
        ttlKnown: v.ttlKnown === true,
      }
    }
    const refreshBig = async (due: Array<{ id: string; path: string }>): Promise<void> => {
      if (bigRunning) return
      bigRunning = true
      let failure = ''
      let results: Record<string, unknown> | undefined
      try {
        // Each file comes with the tool-call count and offset already known, so
        // the helper only counts what was appended since
        const files = due.map(item => {
          const cur = liveExtra[item.id]
          return { id: item.id, path: item.path, toolsAt: cur ? num(cur.bigToolsAt) : 0, tools: cur && cur.bigToolsAt ? cur.tools : 0 }
        })
        const run = await $.process.run(
          ['node', $.plugin.root + '/scripts/big-transcript.cjs', JSON.stringify({ files })],
          { timeoutMs: 20000 },
        )
        const out = run.exitCode === 0 ? parseJson(run.stdout) : undefined
        results = out && isRecord(out.results) ? out.results : undefined
        if (!results) failure = run.exitCode === 0 ? 'unreadable output' : oneLine(run.stderr, 80) || 'exit ' + run.exitCode
      } catch (err) {
        failure = oneLine(String(err), 80)
      }
      due.forEach(item => {
        const cur = liveExtra[item.id]
        if (!cur) return
        const r = results ? results[item.id] : undefined
        if (!isRecord(r) || r.ok !== true) {
          liveExtra[item.id] = Object.assign({}, cur, { bigError: (isRecord(r) ? str(r.error) : '') || failure || 'no result' })
          return
        }
        liveExtra[item.id] = Object.assign({}, cur, {
          cache: cacheFrom(r.cache),
          turnTools: num(r.turnTools),
          tools: r.toolsTotal === undefined ? cur.tools : num(r.toolsTotal),
          bigToolsAt: r.toolsTotal === undefined ? cur.bigToolsAt : num(r.toolsAt),
          lastTool: str(r.lastTool) || cur.lastTool,
          note: str(r.note) || cur.note,
          lastPrompt: str(r.prompt) || cur.lastPrompt,
          usd: r.usd === undefined ? cur.usd : num(r.usd),
          tokIn: r.tokIn === undefined ? cur.tokIn : num(r.tokIn),
          tokOut: r.tokOut === undefined ? cur.tokOut : num(r.tokOut),
          bigSize: num(r.size),
          bigError: undefined,
        })
      })
      bigRunning = false
    }

    // Look for every chat's window in one batch (the focus helper's --probe, one
    // look at the process table) every 30 seconds, so `<o>` shows only where it
    // can work. The last answer stays until the next one is back.
    let probing = false
    const probeFocus = async (): Promise<void> => {
      if (probing) return
      const eligible = liveSessions.filter(l => !l.spare && l.pid > 0)
      if (!eligible.some(l => Date.now() - (focusProbe[l.id]?.at ?? 0) > 30000)) return
      probing = true
      let results: Record<string, unknown> | undefined
      try {
        const items = eligible.map(l => ({ id: l.id, pid: l.pid, jobId: l.kind === 'bg' ? l.jobId || l.id.slice(0, 8) : undefined }))
        const run = await $.process.run(['node', $.plugin.root + '/scripts/focus-window.cjs', '--probe', JSON.stringify(items)], { timeoutMs: 40000 })
        const out = run.exitCode === 0 ? parseJson(run.stdout) : undefined
        results = out && isRecord(out.results) ? out.results : undefined
      } catch {
        // the helper could not run: keep the last answers and try again later
      } finally {
        const at = Date.now()
        for (const l of eligible) {
          const r = results ? results[l.id] : undefined
          focusProbe[l.id] = { ok: results ? isRecord(r) && r.ok === true : focusProbe[l.id]?.ok === true, at }
        }
        probing = false
      }
    }

    // Every 2 seconds, apart from the main timer so a slow read cannot stall
    // it: the sessions the agents panel lists, and for the busy ones a light
    // look at their own transcript
    let scanning = false
    $.clock.every(2000, async () => {
      if (scanning) return
      scanning = true
      try {
        convoScans += 1
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
        if (!home) {
          convoError = 'no HOME or USERPROFILE'
          return
        }
        const myId = await $.session.id()
        const nowMs = Date.now()
        void refreshPlanCost(home)
        const entries = await $.fs.list(home + '/.claude/sessions')
        const rows: Live[] = []
        for (const entry of entries) {
          if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
          const data = parseJson(await $.fs.read(home + '/.claude/sessions/' + entry.name).catch(() => ''))
          if (!data) continue
          const jobId = str(data.jobId)
          const job = jobId
            ? parseJson(await $.fs.read(home + '/.claude/jobs/' + jobId + '/state.json').catch(() => ''))
            : undefined
          const inFlight = job && isRecord(job.inFlight) ? job.inFlight : undefined
          const needs = job ? str(job.needs) : ''
          const parkedId = str(data.parkedJobId)
          const parked = parkedId
            ? parseJson(await $.fs.read(home + '/.claude/jobs/' + parkedId + '/state.json').catch(() => ''))
            : undefined
          rows.push({
            id: str(data.sessionId),
            pid: num(Number.parseInt(entry.name, 10)),
            name: str(data.name) || jobId || str(data.sessionId).slice(0, 8),
            cwd: str(data.cwd),
            kind: str(data.kind),
            busy: parkedId === '' && (str(data.status) === 'busy' || (job !== undefined && str(job.state) === 'working' && needs === '')),
            startedAt: num(data.startedAt),
            since: num(data.statusUpdatedAt) || num(data.updatedAt),
            detail: job ? str(job.detail) : '',
            tokens: job ? num(job.tokens) : 0,
            tasks: inFlight ? num(inFlight.tasks) + num(inFlight.queued) : 0,
            spare: data.spare === true,
            remote: str(data.entrypoint) === 'sdk-cli' || str(data.bridgeSessionId) !== '',
            jobId,
            needs,
            handedTo: parkedId === '' ? '' : (parked ? str(parked.name) : '') || parkedId,
          })
        }
        liveSessions = rows
        liveMine = myId
        convoError = ''

        // Every session's transcript: tool calls, tokens, cost and the prompt
        // cache. A busy session is looked at every 5 seconds, an idle one every
        // 30, and a transcript whose size has not changed is not read again.
        // Running subagents are counted for busy sessions only.
        const listed: Record<string, Array<{ name: string; size: number; mtimeMs: number }>> = {}
        const bigDue: Array<{ id: string; path: string }> = []
        for (const row of rows) {
          if (!row.id || !row.cwd) continue
          const dir = home + '/.claude/projects/' + row.cwd.replace(/[^a-zA-Z0-9]/g, '-')
          const known = liveExtra[row.id]
          if (known && nowMs - known.at <= (isBusy(row, nowMs) ? 5000 : 30000)) continue
          if (!listed[dir]) listed[dir] = await $.fs.list(dir).catch(() => [])
          const file = listed[dir].filter(f => f.name === row.id + '.jsonl')[0]
          const size = file ? file.size : 0
          let extra: LiveExtra = known
            ? Object.assign({}, known, { at: nowMs })
            : { tools: 0, lastTool: '', subs: 0, at: nowMs, note: '', tokIn: 0, tokOut: 0, usd: 0, turnTools: 0, size: -1, exists: false }
          extra.exists = file !== undefined
          if (file) extra.mtimeMs = file.mtimeMs
          if (extra.size !== size && size > 0 && size <= MAX_TRANSCRIPT_BYTES) {
            try {
              const text = await $.fs.read(dir + '/' + row.id + '.jsonl')
              if (typeof text === 'string') {
                const stats = toolStats(text)
                const used = usageStats(text)
                extra = Object.assign({}, extra, {
                  tools: stats.tools,
                  turnTools: turnTools(text),
                  lastTool: stats.lastTool,
                  tokIn: used.tokIn,
                  tokOut: used.tokOut,
                  usd: used.usd,
                  note: latestNote(text),
                  lastPrompt: latestPrompt(text),
                  size,
                  cache: cacheStats(text),
                })
              }
            } catch {
              // not there or unreadable: keep what we had
            }
          }
          // Over the read limit: remember the size so the pane can say so
          if (size > MAX_TRANSCRIPT_BYTES) {
            extra.size = size
            // What was read before the file grew past the limit is out of date,
            // unless the big-transcript reader has read it from the end since
            if (extra.bigSize === undefined) extra.cache = undefined
            if (extra.bigSize !== size) bigDue.push({ id: row.id, path: dir + '/' + row.id + '.jsonl' })
          }
          if (isBusy(row, nowMs)) {
            try {
              const files = await $.fs.list(dir + '/' + row.id + '/subagents')
              extra.subs = files.filter(f => f.kind === 'file' && nowMs - f.mtimeMs < CONVO_WORKING_MS).length
            } catch {
              // no subagents folder
              extra.subs = 0
            }
          }
          liveExtra[row.id] = extra
        }
        if (bigDue.length > 0) void refreshBig(bigDue)
        void probeFocus()
      } catch (err) {
        convoError = String(err)
      } finally {
        scanning = false
      }
    })

    // Once a second: pull agent status and the context fill from the engine,
    // and redraw so run times and the cache countdown tick
    $.clock.every(1000, async () => {
      const infos = await $.agent.list()
      if (!seeded) {
        // Agents that had already finished before this mod loaded belong to
        // an earlier run: keep them out
        seeded = true
        infos.forEach(info => {
          if (info.status !== 'running') hidden[info.id] = true
        })
      }
      const live = infos.filter(info => !hidden[info.id])
      await update($, agents, list => merge(list, live))
      // A row the engine's agent list has never heard of (a tool call tagged
      // with an agent id that was not spawned here) is not a real agent: drop it
      // once it is a few seconds old, and keep it out unless it does more work
      const known: { [id: string]: boolean } = {}
      infos.forEach(info => {
        known[info.id] = true
        listedIds[info.id] = true
      })
      await update($, agents, list =>
        list.filter(row => {
          if (row.id === 'main' || known[row.id] || Date.now() - row.startedAt < ORPHAN_MS) return true
          hidden[row.id] = true
          return false
        }),
      )
      const usage = await $.session.usage()
      await update($, session, s =>
        Object.assign({}, s, {
          ctxPercent: usage.context.percent,
          ctxTokens: usage.context.tokens,
          ctxWindow: usage.context.window,
          usd: usage.cost ? usage.cost.usd : undefined,
          limits: usage.rateLimits.map(r => ({
            kind: r.kind,
            pct: num(r.percentUsed),
            resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : undefined,
          })),
        }),
      )
      // A usage limit past 90%, once per window
      usage.rateLimits.forEach(r => {
        const key = 'limit-' + r.kind + '-' + (r.resetsAt || '')
        if (num(r.percentUsed) >= 90 && !alerted[key]) {
          alerted[key] = true
          const when = r.resetsAt ? ' Resets ' + clockText(Date.parse(r.resetsAt)) + '.' : ''
          $.ui.toast((LIMIT_NAMES[r.kind] || r.kind) + ' is ' + Math.round(num(r.percentUsed)) + '% used.' + when)
        }
      })

      // Alerts, each shown once: an agent that has run a long time, one that
      // failed, and a prompt cache about to lapse
      const now = Date.now()
      const rows = await read($, agents)
      rows.forEach(row => {
        if (row.id === 'main') return
        if (row.status === 'running' && now - row.startedAt > LONG_MS && !alerted['long-' + row.id]) {
          alerted['long-' + row.id] = true
          $.ui.toast(row.name + ' has been running for ' + seconds(now - row.startedAt))
        }
        if (isFailed(row.status) && !alerted['fail-' + row.id]) {
          alerted['fail-' + row.id] = true
          $.ui.toast(row.name + ' ' + statusWord(row.status))
        }
      })
      const sess = await read($, session)
      if (sess.lastAt && num(sess.lastCacheRead) + num(sess.lastCacheWrite) > 0) {
        const cacheLeft = mainTtlMs() - (now - sess.lastAt)
        if (cacheLeft > 0 && cacheLeft <= WARN_CACHE_MS && !alerted['cache-' + sess.lastAt]) {
          alerted['cache-' + sess.lastAt] = true
          $.ui.toast('Prompt cache expires in about ' + seconds(cacheLeft) + '. Send a prompt to keep it warm.')
        }
      }
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('command.run', { command: 'session-monitor' }, async $ => {
    await update($, view, v => Object.assign({}, v, { mode: undefined, note: undefined, scope: undefined }))
    await $.ui.open({ id: PANE, title: 'Session Monitor', focus: true, closeOnEscape: true })
    return {}
  })

  // The same pane, showing only the agents of this chat
  on('command.run', { command: 'agent-monitor' }, async $ => {
    await update($, view, v => Object.assign({}, v, { mode: undefined, note: undefined, scope: 'agents' as const }))
    await $.ui.open({ id: PANE, title: 'Agents', focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'agent-report' }, async $ => {
    await update($, view, v => Object.assign({}, v, { mode: 'report' as const, note: undefined }))
    await $.ui.open({ id: PANE, title: 'Agents', focus: true, closeOnEscape: true })
    return {}
  })

  // A new prompt starts a new run: keep the agents that finished in the last
  // run for the report, drop them from the live view, and start the main
  // session's row afresh
  on('turn.start', async ($, e, next) => {
    // A turn with no typed prompt (a continuation) is part of the same run
    if (!e.text) return next(e)

    let previousPrompt = ''
    let previousAt = 0
    await update($, session, s => {
      previousPrompt = s.runPrompt || ''
      previousAt = s.runAt || 0
      return Object.assign({}, s, { runPrompt: oneLine(e.text, 200), runAt: Date.now() })
    })

    let finished: AgentRow[] = []
    await update($, agents, list => {
      finished = list
        .filter(row => (row.id === 'main' ? row.tools > 0 : row.status !== 'running'))
        .map(row => Object.assign({}, row, { log: row.log.slice(-20) }))
      return upsert(dismissFinished(list), 'main', {
        status: 'running',
        tools: 0,
        last: '',
        log: [],
        byTool: {},
        startedAt: Date.now(),
        endedAt: undefined,
        tokIn: 0,
        tokOut: 0,
        tokCache: 0,
      })
    })

    if (finished.length > 0) {
      await update($, runs, history =>
        history.concat([{ at: previousAt, prompt: previousPrompt, agents: finished }]).slice(-MAX_RUNS),
      )
      // Keep the run on disk: a markdown file for reading, and the history
      // file the next session loads
      try {
        const home = await $.env.get('HOME')
        const dir = reportsDir(home, await $.session.cwd())
        const saved = await read($, runs)
        const learned = await read($, stats)
        await $.fs.write(dir + '/history.json', historyText(saved, learned))
        await $.fs.write(
          dir + '/run-' + fileStamp(previousAt || Date.now()) + '.md',
          ['# Run ' + clock(previousAt || Date.now()), '', previousPrompt ? '> ' + previousPrompt : ''].concat(
            runSection(finished),
          ).join('\n'),
        )
      } catch (err) {
        // Saving is best effort
      }
    }
    await update($, view, v => (v.openId && hidden[v.openId] ? Object.assign({}, v, { openId: undefined }) : v))
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // A subagent is about to start: record it once the engine has given it an id
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (id) {
      delete hidden[id]
      await update($, agents, list =>
        upsert(list, id, {
          name: e.name || e.description,
          type: e.subagentType,
          parentId: e.parentAgentId || 'main',
          status: 'running',
          startedAt: Date.now(),
          endedAt: undefined,
          model: result.model || undefined,
          task: oneLine(e.prompt || e.description || '', 280),
        }),
      )
    }
    return result
  }).catch(async ($, e, next) => next(e))

  // Every tool call, attributed to the loop it ran in
  on('tool.call', async ($, e, next) => {
    // Claude Code's own helpers (the prompt suggestion, for one) tag tool calls
    // with an agent id that was never spawned as an agent: leave those alone
    if (e.agentId) {
      const tracked = await read($, agents)
      if (!listedIds[e.agentId] && !tracked.some(row => row.id === e.agentId)) return next(e)
    }
    const id = e.agentId || 'main'
    delete hidden[id]
    const detail = summarize(e as unknown as Record<string, unknown>)
    await update($, agents, list => bumpTool(list, id, String(e.tool), detail))

    const rows = await read($, agents)
    const self = rows.filter(row => row.id === id)[0]
    if (self && num(self.repeat) >= LOOP_AT && !alerted['loop-' + id + '-' + self.last]) {
      alerted['loop-' + id + '-' + self.last] = true
      $.ui.toast(self.name + ' made the same call ' + self.repeat + ' times: ' + cut(self.last, 60))
    }

    const result = await next(e)
    if (result && result.isError) {
      const message = oneLine(String(result.text || 'error'), 160)
      await update($, agents, list => {
        const row = list.filter(item => item.id === id)[0]
        return upsert(list, id, { errors: num(row && row.errors) + 1, lastError: String(e.tool) + ': ' + message })
      })
    }
    return result
  }).catch(async ($, e, next) => next(e))

  // Every model request: its response ends with the tokens it used
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId || 'main'
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop' && chunk.usage) {
        const usage = chunk.usage
        await update($, agents, list => addTokens(list, id, usage))
        await update($, session, s => addSession(s, usage, id === 'main'))
      } else if (chunk.kind === 'stop') {
        // A response that reported no token counts: remember it, so the pane
        // can say so
        await update($, session, s => Object.assign({}, s, { steps: num(s.steps) + 1 }))
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId || 'main'
    const seen: { row?: AgentRow } = {}
    await update($, agents, list => {
      seen.row = list.filter(row => row.id === id && row.status === 'running')[0]
      if (id === 'main') return upsert(list, 'main', { status: 'idle', endedAt: Date.now() })
      const patch: Partial<AgentRow> = { status: e.isAborted ? 'killed' : 'done', endedAt: Date.now() }
      if (e.answer) patch.result = oneLine(e.answer, 500)
      return upsert(list, id, patch)
    })

    // A subagent that just finished teaches the progress estimate how many
    // calls an agent of its type tends to make
    const done = seen.row
    if (id !== 'main' && done && done.tools > 0) {
      await update($, stats, learned => {
        const entry = learned[done.type] || { n: 0, calls: 0 }
        const out = Object.assign({}, learned)
        out[done.type] = { n: entry.n + 1, calls: entry.calls + done.tools }
        return out
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    // Mobile surfaces have no text field
    const Input = 'Input' in els ? els.Input : undefined
    const list = await read($, agents)
    const s = await read($, session)
    const v = await read($, view)
    // /agent-monitor shows this chat's agents only: no limits, cache or other chats
    const agentsOnly = v.scope === 'agents'
    const history = await read($, runs)
    const learned = await read($, stats)
    const cols = Math.max(24, e.props.bodyColumns || 60)
    const barWidth = cols >= 64 ? 16 : cols >= 44 ? 12 : 8

    // ---- the report view ---------------------------------------------------
    if (v.mode === 'report') {
      const full = buildReport(list, history, s)
      const shown =
        full.length > MAX_REPORT_VIEW
          ? full.slice(0, MAX_REPORT_VIEW) + '\n\n_… the rest is in the copied or saved report._'
          : full
      return Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 3,
            children: [
              Button({
                key: 'back',
                label: 'Back',
                hotkey: 'b',
                plain: true,
                onPress: async () => {
                  await update($, view, current => Object.assign({}, current, { mode: undefined, note: undefined }))
                },
              }),
              Button({
                key: 'copy',
                label: 'Copy',
                hotkey: 'y',
                plain: true,
                onPress: async () => {
                  const done = await $.ui.copy({ text: full })
                  $.ui.toast(done.isCopied ? 'Report copied' : 'Could not copy the report')
                },
              }),
              Button({
                key: 'save',
                label: 'Save',
                hotkey: 's',
                plain: true,
                onPress: async () => {
                  const home = await $.env.get('HOME')
                  const path = reportsDir(home, await $.session.cwd()) + '/agent-report-' + fileStamp(Date.now()) + '.md'
                  await $.fs.write(path, full)
                  await update($, view, current => Object.assign({}, current, { note: 'Saved to ' + path }))
                  $.ui.toast('Report saved')
                },
              }),
              Button({
                key: 'json',
                label: 'JSON',
                hotkey: 'j',
                plain: true,
                onPress: async () => {
                  const home = await $.env.get('HOME')
                  const path = reportsDir(home, await $.session.cwd()) + '/agent-report-' + fileStamp(Date.now()) + '.json'
                  await $.fs.write(path, buildJson(list, history, s))
                  await update($, view, current => Object.assign({}, current, { note: 'Saved to ' + path }))
                  $.ui.toast('JSON saved')
                },
              }),
              Button({
                key: 'csv',
                label: 'CSV',
                hotkey: 'v',
                plain: true,
                onPress: async () => {
                  const home = await $.env.get('HOME')
                  const path = reportsDir(home, await $.session.cwd()) + '/agent-report-' + fileStamp(Date.now()) + '.csv'
                  await $.fs.write(path, buildCsv(list, history, s))
                  await update($, view, current => Object.assign({}, current, { note: 'Saved to ' + path }))
                  $.ui.toast('CSV saved')
                },
              }),
            ],
          }),
          Text({ dimColor: true, children: [v.note ? v.note : 'Copy, or save as markdown, JSON or CSV. Runs are also saved automatically.'] }),
          Markdown({ key: 'report', text: shown }),
        ],
      })
    }

    // ---- the live view -----------------------------------------------------
    const query = v.query || ''
    const shownList = list.filter(row => {
      if (v.filter === 'running' && row.status !== 'running') return false
      if (v.filter === 'failed' && !isFailed(row.status) && num(row.errors) === 0) return false
      return matches(row, query)
    })
    const rows = ordered(shownList)
    const subs = list.filter(row => row.id !== 'main')
    const running = subs.filter(row => row.status === 'running').length
    const finished = subs.filter(row => isDone(row.status)).length
    const failed = subs.filter(row => isFailed(row.status)).length

    // ---- summary -----------------------------------------------------------
    const counts = [running + ' running', finished + ' done']
    if (failed > 0) counts.push(failed + ' failed')

    const sessionTokens = tokenLine(s.tokIn, s.tokOut)
    const cached = num(s.tokCache) > 0 ? ' · cached ' + fmt(s.tokCache) : ''

    // Named like the "Cache by chat" rows: the figures below are this chat's own
    const mine = liveSessions.filter(l => l.id === liveMine)[0]
    const sessionHeading = 'This session' + (mine ? ' · ' + mine.name : '')

    const summary = [
      Text({ bold: true, color: 'cyan', children: [cut(sessionHeading, cols)] }),
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: cols,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ bold: true, children: ['Agents'] }),
              Text({ dimColor: true, children: [counts.join(' · ')] }),
            ],
          }),
          Text({ children: [s.usd !== undefined ? 'session ' + money(s.usd) : ''] }),
        ],
      }),
      Text({ dimColor: true, children: ['session ' + sessionTokens + cached] }),
    ]

    // Context window of the main session: real figures, not estimates
    if (s.ctxPercent !== undefined) {
      const ctx = bar(s.ctxPercent, barWidth)
      const hot = s.ctxPercent >= 85 ? 'red' : s.ctxPercent >= 70 ? 'yellow' : 'cyan'
      const used = num(s.ctxTokens)
      const win = num(s.ctxWindow)
      const left = win > 0 ? Math.max(0, win - used) : 0
      const figures = win > 0 ? fmt(used) + ' / ' + fmt(win) + ' · ' + fmt(left) + ' left' : s.ctxPercent + '%'
      summary.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ dimColor: true, children: ['context '] }),
            Text({ color: hot, children: [ctx.filled] }),
            Text({ dimColor: true, children: [ctx.empty] }),
            Text({ children: [s.ctxPercent + '%'] }),
            Text({ dimColor: true, children: [cut(figures, Math.max(8, cols - barWidth - 16))] }),
          ],
        }),
      )
    }

    // Usage limits (the 5-hour and weekly windows) as the last response reported
    // them: real figures, empty off a subscription
    const limitRows = (s.limits || [])
      .slice()
      .sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
      .map(r => {
        const hot = r.pct >= 90 ? 'red' : r.pct >= 70 ? 'yellow' : 'green'
        const meter = bar(r.pct, barWidth)
        const est = planCost.usd[r.kind]
        const cost = est !== undefined ? '~' + money(est) : ''
        const reset = r.resetsAt === undefined ? '' : 'resets in ' + untilText(r.resetsAt - Date.now()) + ' (' + clockText(r.resetsAt) + ')'
        // The cost sits at the right edge, like the session and working costs
        return Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          width: cols,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ dimColor: true, children: [(LIMIT_NAMES[r.kind] || r.kind).padEnd(10)] }),
                Text({ color: hot, children: [meter.filled] }),
                Text({ dimColor: true, children: [meter.empty] }),
                Text({ children: [Math.round(r.pct) + '%'] }),
                Text({ dimColor: true, children: [cut(reset, Math.max(8, cols - barWidth - 30))] }),
              ],
            }),
            Text({ children: [cost] }),
          ],
        })
      })
    // They head the pane, above the session's own figures: the account's, not the chat's
    if (limitRows.length > 0 && !agentsOnly) {
      const costNote = planCost.error ? 'cost n/a: ' + planCost.error : Object.keys(planCost.usd).length > 0 ? 'cost = est. at API prices, this machine' : ''
      const plan = [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ bold: true, color: 'magenta', children: ['My Plan'] }),
            Text({ dimColor: true, children: [cut(costNote, Math.max(8, cols - 12))] }),
          ],
        }),
      ].concat(limitRows, [Text({ children: [' '] })])
      plan.reverse().forEach(el => summary.unshift(el))
    }

    // The prompt cache, as of the main session's latest request: how much of
    // its input the cache served, and how long until the entry lapses
    const cacheRead = num(s.lastCacheRead)
    const wrote = num(s.lastCacheWrite)
    const fresh = num(s.lastUncached)
    const inputTotal = cacheRead + wrote + fresh
    if (agentsOnly) {
      // The cache gauge belongs to the full view
    } else if (inputTotal > 0) {
      const hitPct = Math.round((cacheRead / inputTotal) * 100)
      const hit = bar(hitPct, barWidth)
      const hitColor = hitPct >= 70 ? 'green' : hitPct >= 40 ? 'yellow' : 'red'
      summary.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ dimColor: true, children: ['cache   '] }),
            Text({ color: hitColor, children: [hit.filled] }),
            Text({ dimColor: true, children: [hit.empty] }),
            Text({ children: [hitPct + '% hit'] }),
            Text({
              dimColor: true,
              children: [cut('read ' + fmt(cacheRead) + ' · written ' + fmt(wrote) + ' · new ' + fmt(fresh), Math.max(8, cols - barWidth - 22))],
            }),
          ],
        }),
      )

      const ttlMs = mainTtlMs()
      const own = liveExtra[liveMine]
      const ownCache = own ? own.cache : undefined
      const ttlText = ttlLabel(ttlMs, ownCache !== undefined && ownCache.ttlKnown)
      const age = s.lastAt ? Date.now() - s.lastAt : ttlMs
      const leftMs = Math.max(0, ttlMs - age)
      if (leftMs > 0) {
        const lifePct = Math.round((leftMs / ttlMs) * 100)
        const life = bar(lifePct, barWidth)
        const lifeColor = lifePct >= 40 ? 'cyan' : lifePct >= 15 ? 'yellow' : 'red'
        summary.push(
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ dimColor: true, children: ['expires '] }),
              Text({ color: lifeColor, children: [life.filled] }),
              Text({ dimColor: true, children: [life.empty] }),
              Text({ children: ['~' + seconds(leftMs) + ' left'] }),
              Text({ dimColor: true, children: ['of ' + ttlText] }),
            ],
          }),
        )
      } else {
        summary.push(
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ dimColor: true, children: ['expires '] }),
              Text({ color: 'red', children: ['expired'] }),
              Text({ dimColor: true, children: ['· the next request rebuilds it'] }),
            ],
          }),
        )
      }
    } else {
      summary.push(Text({ dimColor: true, children: ['cache   –'] }))
    }

    // ---- what one agent did ------------------------------------------------
    const detailOf = (row: AgentRow, room: number) => {
      const parts = []
      if (row.task) {
        parts.push(Text({ dimColor: true, children: ['task'] }))
        parts.push(Text({ wrap: 'wrap', children: [row.task] }))
      }
      parts.push(
        Text({ dimColor: true, children: ['actions' + (row.tools > 0 ? ' (' + row.tools + ')' : '')] }),
      )
      const shown = row.log.slice(-SHOW_LOG)
      if (shown.length === 0) {
        parts.push(Text({ dimColor: true, children: ['  none yet'] }))
      }
      if (row.tools > shown.length) {
        parts.push(Text({ dimColor: true, children: ['  … ' + (row.tools - shown.length) + ' earlier'] }))
      }
      shown.forEach(entry => {
        const at = ('+' + seconds(entry.at)).padStart(6)
        const room2 = Math.max(6, room - at.length - entry.tool.length - 4)
        parts.push(
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ dimColor: true, children: ['  ' + at] }),
              Text({ bold: true, children: [entry.tool] }),
              Text({ dimColor: true, children: [cut(entry.detail, room2)] }),
            ],
          }),
        )
      })
      if (row.lastError) {
        parts.push(Text({ dimColor: true, children: ['last error'] }))
        parts.push(Text({ color: 'red', wrap: 'wrap', children: [row.lastError] }))
      }
      if (row.result) {
        parts.push(Text({ dimColor: true, children: ['result'] }))
        parts.push(Text({ wrap: 'wrap', children: [row.result] }))
      }
      return Box({ flexDirection: 'column', marginTop: 1, marginLeft: 2, children: parts })
    }

    // Tokens and estimated cost on one line; the model when it is known
    const tokenCost = (row: AgentRow): string =>
      tokenLine(row.tokIn, row.tokOut) +
      (row.usd !== undefined && row.usd > 0 ? ' · ~' + money(row.usd) : '') +
      (row.model ? ' · ' + row.model : '')

    // ---- needs attention: failures and tool errors, above everything else --
    const trouble = list.filter(row => row.id !== 'main' && (isFailed(row.status) || num(row.errors) > 0))
    const attention = trouble.length === 0
      ? []
      : [
          Box({
            flexDirection: 'column',
            children: [Text({ color: 'red', bold: true, children: ['Needs attention'] })].concat(
              trouble.slice(0, 4).map(row =>
                Text({
                  color: 'red',
                  children: [
                    cut(
                      (isFailed(row.status) ? '✗ ' + row.name + ' ' + statusWord(row.status) : '⚠ ' + row.name) +
                        (num(row.errors) > 0 ? ' · ' + row.errors + ' error' + (row.errors === 1 ? '' : 's') : '') +
                        (row.lastError ? ' · ' + row.lastError : row.last ? ' · last: ' + row.last : ''),
                      cols,
                    ),
                  ],
                }),
              ),
            ),
          }),
        ]

    // ---- one block per agent ----------------------------------------------
    const blocks = rows.map(item => {
      const row = item.row
      const indent = '  '.repeat(item.depth + 1)
      const room = Math.max(10, cols - indent.length)
      const calls = row.tools + (row.tools === 1 ? ' call' : ' calls')
      const color = colorOf(row.status)
      const isOpen = v.openId === row.id

      // Title line: marker, name (press to open its activity) and type on the
      // left, run time on the right
      const title = Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: room,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color, bold: row.status === 'running', children: [marker(row.status)] }),
              Button({
                key: 'open-' + row.id,
                label: (isOpen ? '▾ ' : '▸ ') + cut(row.name, Math.max(8, room - 28)),
                plain: true,
                onPress: async () => {
                  await update($, view, current =>
                    Object.assign({}, current, { openId: current.openId === row.id ? undefined : row.id }),
                  )
                },
              }),
              Text({ dimColor: true, children: [row.type] }),
            ],
          }),
          Text({ dimColor: true, children: [elapsed(row)] }),
        ],
      })

      const lines = [title]

      if (row.status === 'running') {
        // A running agent gets a progress bar and what it is doing right now
        const pct = progressOf(row, learned)
        const meter = bar(pct, barWidth)
        lines.push(
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ children: ['  '] }),
              Text({ color, children: [meter.filled] }),
              Text({ dimColor: true, children: [meter.empty] }),
              Text({ children: ['~' + pct + '%'] }),
              Text({ dimColor: true, children: [calls] }),
            ],
          }),
        )
        lines.push(Text({ dimColor: true, children: [cut('  ' + tokenCost(row), room)] }))
        if (row.last) {
          lines.push(Text({ dimColor: true, children: ['  ↳ ' + cut(row.last, room - 4)] }))
        }
      } else {
        // A finished or idle agent takes two quiet lines
        const word = row.id === 'main' ? row.status : statusWord(row.status)
        const errs = num(row.errors) > 0 ? ' · ' + row.errors + (row.errors === 1 ? ' error' : ' errors') : ''
        lines.push(Text({ dimColor: true, children: ['  ' + cut(word + ' · ' + calls + errs, room - 2)] }))
        lines.push(Text({ dimColor: true, children: [cut('  ' + tokenCost(row), room)] }))
      }

      // With subagents: what the whole branch used
      const branch = rollup(list, row)
      if (branch.kids > 0) {
        lines.push(
          Text({
            dimColor: true,
            children: [
              cut(
                '  with ' + branch.kids + (branch.kids === 1 ? ' subagent' : ' subagents') + ' ' +
                  tokenLine(branch.tokIn, branch.tokOut) + (branch.usd > 0 ? ' · ~' + money(branch.usd) : ''),
                room,
              ),
            ],
          }),
        )
      }

      if (isOpen) lines.push(detailOf(row, room))

      return Box({ flexDirection: 'column', marginLeft: indent.length, children: lines })
    })

    // ---- footer ------------------------------------------------------------
    const hasLearned = Object.keys(learned).some(type => num(learned[type]?.n) >= 2)
    const hotkeys = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({
          key: 'report',
          label: 'Report',
          hotkey: 'r',
          plain: true,
          onPress: async () => {
            await update($, view, current => Object.assign({}, current, { mode: 'report' as const, note: undefined }))
          },
        }),
        Button({
          key: 'clear',
          label: 'Clear finished',
          hotkey: 'c',
          plain: true,
          onPress: async () => {
            await update($, agents, current => dismissFinished(current))
            await update($, view, current =>
              current.openId && hidden[current.openId] ? Object.assign({}, current, { openId: undefined }) : current,
            )
          },
        }),
        Button({
          key: 'filter',
          label: 'Show: ' + (v.filter || 'all'),
          hotkey: 'f',
          plain: true,
          onPress: async () => {
            await update($, view, current =>
              Object.assign({}, current, {
                filter: current.filter === undefined ? ('running' as const) : current.filter === 'running' ? ('failed' as const) : undefined,
              }),
            )
          },
        }),
        ...(agentsOnly ? [] : [Button({
          key: 'idle-toggle',
          label: 'Idle chats: ' + (v.showIdle === false ? 'hidden' : 'shown'),
          hotkey: 'i',
          plain: true,
          onPress: async () => {
            await update($, view, current => Object.assign({}, current, { showIdle: current.showIdle === false ? true : false }))
          },
        }),
        Button({
          key: 'cache-toggle',
          label: 'Cache info: ' + (v.hideCache ? 'hidden' : 'shown'),
          hotkey: 'h',
          plain: true,
          onPress: async () => {
            await update($, view, current => Object.assign({}, current, { hideCache: current.hideCache ? undefined : true }))
          },
        })]),
        Button({
          key: 'scope-toggle',
          label: 'View: ' + (agentsOnly ? 'agents' : 'full'),
          hotkey: 'm',
          plain: true,
          onPress: async () => {
            await update($, view, current => Object.assign({}, current, { scope: current.scope === 'agents' ? undefined : ('agents' as const) }))
          },
        }),
      ],
    })
    // Two italic notes above the hotkeys, which stay at the bottom
    const footer = Box({
      flexDirection: 'column',
      children: [
        ...(agentsOnly ? [] : [Text({ dimColor: true, italic: true, wrap: 'wrap', children: ['<o> raises the terminal window of that chat'] })]),
        ...(running > 0
          ? [Text({ dimColor: true, italic: true, wrap: 'wrap', children: [hasLearned ? '~ estimated, learned from past runs' : '~ estimated from tool calls'] })]
          : [
              Text({ dimColor: true, italic: true, wrap: 'wrap', children: ['press a subagent name to see what it did'] }),
              ...(agentsOnly ? [] : [Text({ dimColor: true, italic: true, wrap: 'wrap', children: ['press a chat name under Other chats for its details'] })]),
            ]),
        hotkeys,
      ],
    })

    const search = !Input ? [] : [Input({
      key: 'search',
      label: 'search ',
      placeholder: 'agent, tool, file…',
      value: query,
      submitLabel: 'find',
      onInput: (value: string) => {
        void update($, view, current => Object.assign({}, current, { query: value || undefined }))
      },
      onSubmit: (value: string) => {
        void update($, view, current => Object.assign({}, current, { query: value || undefined }))
      },
    })]

    // Token counts arrive with each model response; if responses came in but
    // none carried counts, say so rather than showing dashes without a reason
    const noUsage = num(s.steps) > 0 && num(s.usageSeen) === 0

    const renderNow = Date.now()
    // This chat is the "This session" block above, and its subagents the Agents
    // list: the sections below cover the other chats only, so nothing is counted twice
    const others = liveSessions.filter(l => l.id !== liveMine)
    const busy = others.filter(l => isBusy(l, renderNow)).sort((a, b) => a.since - b.since)
    const idle = others.length - busy.length
    const subCount = (l: Live): number => Math.max(l.tasks, subsOf(l.id))
    const workingAgents = busy.reduce((sum, l) => sum + subCount(l), 0)
    const workingCount = busy.length + workingAgents
    const liveUsd = busy.reduce((sum, l) => sum + usdOf(l.id), 0)
    // Every other chat, busy or idle: an estimate, and a chat with no readable
    // cost figure adds nothing
    const othersUsd = others.reduce((sum, l) => sum + usdOf(l.id), 0)
    // Raise the window that hosts a chat (scripts/focus-window.cjs, for Windows,
    // macOS and Linux). It finds the window, and the tab only in macOS Terminal
    // and iTerm2: chats in one Windows Terminal or Cursor window share it.
    const focusChat = async (l: Live): Promise<string> => {
      const job = l.kind === 'bg' && !l.spare
      const jobId = l.jobId || l.id.slice(0, 8)
      try {
        const run = await $.process.run(
          ['node', $.plugin.root + '/scripts/focus-window.cjs', String(l.pid)].concat(job ? ['--viewer-of', jobId] : [], l.cwd ? ['--cwd', l.cwd] : []),
          { timeoutMs: 20000 },
        )
        const out = run.exitCode === 0 ? parseJson(run.stdout) : undefined
        if (!out) return 'Could not run the focus helper: ' + (oneLine(run.stderr, 80) || 'exit ' + run.exitCode)
        if (out.ok !== true) {
          // Nothing is showing the job: put the command that opens it on the clipboard
          if (job) {
            const attach = attachCommand(l)
            const done = await $.ui.copy({ text: attach })
            return 'No terminal is showing this job. ' + (done.isCopied ? 'Copied: ' : 'Run: ') + attach
          }
          return str(out.error) || 'No window found'
        }
        return 'Raised ' + (str(out.host) || 'window') + (str(out.title) ? ': ' + cut(str(out.title), 50) : '') + (str(out.how) === 'tab' ? ' (tab)' : '') + (num(out.windows) > 1 && out.matched !== true ? ' (none of its ' + num(out.windows) + " windows names this chat's folder)" : '')
      } catch (err) {
        return 'Could not run the focus helper: ' + oneLine(String(err), 80)
      }
    }
    // A spare worker has no terminal to raise; a background job's is whichever
    // `claude attach` or `claude agents` terminal is showing it
    const canFocus = (l: Live): boolean => l.pid > 0 && !l.spare && focusProbe[l.id]?.ok === true
    // What opens a background job when no terminal is showing it
    const attachCommand = (l: Live): string => (l.kind === 'bg' && !l.spare ? 'claude attach ' + (l.jobId || l.id.slice(0, 8)) : '')
    // The columns before a chat's name, six cells wide for every chat: `<o>`,
    // which raises the chat's terminal or, for a background job, copies the
    // command that attaches to it, then the status dot. A chat with neither
    // action (a spare worker) leaves the `<o>` cell blank so the names line up.
    const focusMarker = (l: Live, dot: string, color: string | undefined) => {
      const eye = canFocus(l)
        ? Button({
            key: 'eye-' + l.id,
            label: '<o>',
            plain: true,
            onPress: async () => {
              $.ui.toast(await focusChat(l))
            },
          })
        : Text({ children: ['   '] })
      return Box({
        flexDirection: 'row',
        children: [eye, Text({ color, dimColor: color === undefined, children: [' ' + dot + ' '] })],
      })
    }
    // Press a chat's name to open or close what is known about it; one chat is
    // open at a time, apart from the open subagent
    const toggleChat = (id: string) => async (): Promise<void> => {
      await update($, view, current => Object.assign({}, current, { openChat: current.openChat === id ? undefined : id, confirmStop: undefined }))
    }
    const chatDetail = (l: Live) => {
      const c = liveExtra[l.id]
      const lines: Array<ReturnType<typeof Text>> = []
      // `right` is a control kept at the right edge of the row, in line with the costs
      const fact = (label: string, value: string, right?: ReturnType<typeof Button>): void => {
        if (!value) return
        const main = Box({
          flexDirection: 'row',
          columnGap: 1,
          flexShrink: 1,
          children: [
            Box({ width: 8, flexShrink: 0, children: [Text({ dimColor: true, children: [label] })] }),
            Box({ flexGrow: 1, flexShrink: 1, children: [Text({ wrap: 'wrap', children: [value] })] }),
          ],
        })
        lines.push(right ? Box({ flexDirection: 'row', justifyContent: 'space-between', width: Math.max(10, cols - 4), children: [main, right] }) : main)
      }
      // A background job can be stopped: its conversation is kept and `claude attach`
      // brings it back. Two presses, and never `claude rm`, which deletes it.
      const stopJob =
        l.kind === 'bg' && !l.spare
          ? Button({
              key: 'stop-' + l.id,
              label: v.confirmStop === l.id ? '■ Press again to stop' : '■ Stop job',
              plain: true,
              onPress: async () => {
                if (v.confirmStop !== l.id) {
                  await update($, view, current => Object.assign({}, current, { confirmStop: l.id }))
                  return
                }
                await update($, view, current => Object.assign({}, current, { confirmStop: undefined }))
                const id = l.jobId || l.id.slice(0, 8)
                try {
                  const run = await $.process.run(['claude', 'stop', id], { timeoutMs: 30000 })
                  $.ui.toast(
                    run.exitCode === 0
                      ? 'Stopped ' + cut(l.name, 30) + '. claude attach ' + id + ' brings it back'
                      : 'Could not stop it: ' + (oneLine(run.stderr || run.stdout, 80) || 'exit ' + run.exitCode),
                  )
                } catch (err) {
                  $.ui.toast('Could not stop it: ' + oneLine(String(err), 80))
                }
              },
            })
          : undefined
      fact('folder', l.cwd)
      fact('handoff', l.handedTo ? 'background job "' + l.handedTo + '"' : '')
      // The stop control sits on this short row, not the later `prompt` row, so a long
      // prompt can't make it look like part of the prompt text
      fact('kind', [l.kind, l.spare ? 'spare' : '', l.remote ? 'remote control' : ''].filter(t => t !== '').join(' · '), stopJob)
      // A working chat's row already shows how long it has worked, its tokens
      // and its context, and every row shows the cost, so the block leaves them out
      const working = isBusy(l, renderNow)
      fact('started', l.startedAt > 0 ? seconds(renderNow - l.startedAt) + ' ago' : 'unknown')
      fact('prompt', c ? c.lastPrompt || '' : '')
      if (!working) fact('idle', l.since > 0 ? seconds(renderNow - l.since) : '')
      fact('latest', cut(l.detail || (c ? c.note : ''), Math.max(20, cols * 2)))
      if (c) {
        fact('tools', c.tools > 0 ? c.tools + ' calls' + (c.lastTool ? ' · last ' + c.lastTool : '') + (c.turnTools > 0 ? ' · ' + c.turnTools + ' this turn' : '') : '')
        fact('agents', subCount(l) > 0 ? String(subCount(l)) : '')
        if (!working) fact('tokens', c.tokIn + c.tokOut > 0 ? tokenLine(c.tokIn, c.tokOut) : '')
        const ci = c.cache
        if (ci && !v.hideCache) {
          const lapse = ci.lastAt + ci.ttlMs - renderNow
          if (!working) fact('ctx', fmt(ci.ctxTokens) + ' · read ' + fmt(ci.read) + ' · written ' + fmt(ci.wrote) + ' · fresh ' + fmt(ci.fresh) + ' · ' + ci.hitPct + '% hit')
          if (!working) fact('cache', lapse > 0 ? '~' + untilText(lapse) + ' of ' + ttlLabel(ci.ttlMs, ci.ttlKnown) : 'expired')
        }
        fact('problem', c.bigError ? 'unreadable: ' + c.bigError : '')
      }
      if (lines.length === 0) lines.push(Text({ dimColor: true, children: ['nothing known yet'] }))
      return Box({ flexDirection: 'column', marginLeft: 4, children: lines })
    }
    // The cost sits at the right edge of each busy chat's title, like the idle rows
    const busyCost = (l: Live): string => (usdOf(l.id) > 0 ? '~' + money(usdOf(l.id)) : '')
    const busyCostW = busy.reduce((m, l) => Math.max(m, busyCost(l).length), 0)
    const liveRows = busy.map(l => {
      const c = liveExtra[l.id]
      const facts: string[] = []
      const tokens = l.tokens > 0 ? l.tokens : c ? c.tokIn + c.tokOut : 0
      if (tokens > 0) facts.push(fmt(tokens) + ' tokens')
      if (c && c.tools > 0) facts.push(c.tools + ' tool calls')
      if (c && c.lastTool) facts.push('last ' + c.lastTool)
      if (subCount(l) > 0) facts.push(subCount(l) + (subCount(l) === 1 ? ' agent' : ' agents'))
      const factsText = facts.length > 0 ? facts.join(' · ') : c && c.exists ? 'no requests in the transcript yet' : 'no transcript yet'
      const turnPct = c ? turnProgress(c.turnTools) : 0
      const turnBar = bar(turnPct, Math.min(barWidth, 12))
      const age = l.since > 0 ? seconds(renderNow - l.since) : '-'
      const head = l.kind ? ' · ' + l.kind : ''
      // Context, hit rate and time left live on the row; the expanded block leaves them out
      const ci = c && !v.hideCache ? c.cache : undefined
      const lapse = ci ? ci.lastAt + ci.ttlMs - renderNow : 0
      const cacheColor = !ci ? undefined : lapse <= 0 ? 'red' : lapse / ci.ttlMs >= 0.4 ? 'cyan' : lapse / ci.ttlMs >= 0.15 ? 'yellow' : 'red'
      const cacheLine = ci
        ? Text({
            color: cacheColor,
            children: [cut('  ctx ' + fmt(ci.ctxTokens) + ' · ' + ci.hitPct + '% hit · ' + (lapse > 0 ? '~' + untilText(lapse) + ' of ' + ttlLabel(ci.ttlMs, ci.ttlKnown) : 'cache expired'), cols)],
          })
        : undefined
      return Box({
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            width: cols,
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  focusMarker(l, '●', 'green'),
                  Button({
                    key: 'chat-' + l.id,
                    label: cut(l.name + head, Math.max(10, cols - age.length - busyCostW - 13)),
                    plain: true,
                    onPress: toggleChat(l.id),
                  }),
                  Text({ dimColor: true, children: [age] }),
                ],
              }),
              Text({ children: [busyCost(l).padStart(busyCostW)] }),
            ],
          }),
          Text({ dimColor: true, children: [cut('  ↳ ' + (l.detail || (c && c.note) || 'working'), cols)] }),
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ children: ['  '] }),
              Text({ color: 'green', children: [turnBar.filled] }),
              Text({ dimColor: true, children: [turnBar.empty] }),
              Text({ children: ['~' + turnPct + '%'] }),
              Text({ dimColor: true, children: [(c ? c.turnTools : 0) + ' calls this turn'] }),
            ],
          }),
          Text({ dimColor: true, children: [cut('  ' + factsText, cols)] }),
        ]
          .concat(cacheLine ? [cacheLine] : [])
          .concat(v.openChat === l.id ? [chatDetail(l)] : []),
      })
    })
    // Idle chats are still running processes, so "Idle chats" lists every one:
    // live caches first (soonest to lapse on top), then lapsed ones, then chats
    // with no readable request. Each chat's own transcript says when its latest
    // request was and whether its cache lasts 5 minutes or an hour.
    const idleEntries = others
      .filter(l => !isBusy(l, renderNow))
      .map(l => {
        const c = liveExtra[l.id]
        const info = c ? c.cache : undefined
        const left = info ? info.lastAt + info.ttlMs - renderNow : 0
        const group = !info ? 2 : left > 0 ? 0 : 1
        return { l, size: c ? c.size : 0, exists: c ? c.exists : false, bigError: c ? c.bigError : undefined, info, left, group }
      })
      .sort((a, b) => (a.group !== b.group ? a.group - b.group : a.group === 0 ? a.left - b.left : a.group === 1 ? b.left - a.left : a.l.name.localeCompare(b.l.name)))
    const liveIdle = idleEntries.filter(x => x.group === 0)
    const nextLapse = liveIdle[0]

    // What each row says on the right: the time left, or why there is none
    const idleRight = (x: (typeof idleEntries)[number]): string => {
      if (x.l.handedTo) return 'handed off to ' + cut(x.l.handedTo, 24)
      if (v.hideCache) return ''
      if (!x.info) {
        if (x.l.spare) return 'spare'
        if (x.size > MAX_TRANSCRIPT_BYTES) return x.bigError ? 'unreadable: ' + x.bigError : 'transcript over 4 MiB'
        if (x.l.remote) return 'remote control, idle'
        if (x.l.needs) return 'waiting: ' + cut(x.l.needs, 40)
        return x.exists ? 'no requests yet' : 'no transcript yet'
      }
      return x.left > 0 ? '~' + untilText(x.left) + ' of ' + ttlLabel(x.info.ttlMs, x.info.ttlKnown) : 'cache expired'
    }
    const ctxText = (x: (typeof idleEntries)[number]): string => (x.info && !v.hideCache ? 'ctx ' + fmt(x.info.ctxTokens) : '')
    const hitText = (x: (typeof idleEntries)[number]): string => (x.info && !v.hideCache ? x.info.hitPct + '% hit' : '')
    const widest = (texts: string[]): number => texts.reduce((m, t) => Math.max(m, t.length), 0)
    const ctxW = widest(idleEntries.map(ctxText))
    const hitW = widest(idleEntries.map(hitText))
    const rightW = widest(idleEntries.map(idleRight))
    // The right edge is all cost: each idle chat's own, then the idle total
    const costText = (x: (typeof idleEntries)[number]): string => (usdOf(x.l.id) > 0 ? '~' + money(usdOf(x.l.id)) : '')
    const costW = widest(idleEntries.map(costText))
    const idleUsd = idleEntries.reduce((sum, x) => sum + usdOf(x.l.id), 0)
    // Pad the names so ctx and hit line up in columns, but only when the window
    // has room for the name, both figures and the time left on one line
    const roomForName = cols - rightW - ctxW - hitW - costW - 13
    const nameW = Math.min(widest(idleEntries.map(x => x.l.name)), Math.floor(cols / 2), roomForName)
    const aligned = nameW >= 10
    const idleRows = idleEntries.map(x => {
      const { l, info, left, group } = x
      const color = group === 2 ? undefined : group === 1 ? 'red' : left / (info ? info.ttlMs : 1) >= 0.4 ? 'cyan' : left / (info ? info.ttlMs : 1) >= 0.15 ? 'yellow' : 'red'
      const name = aligned ? cut(l.name, nameW).padEnd(nameW) : cut(l.name, Math.max(10, Math.floor(cols / 3)))
      // Context, hit rate and the time left sit on the left; the right edge is the cost
      const idleOpen = v.openChat === l.id
      const row = Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: cols,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              focusMarker(l, group === 2 ? '○' : '●', color),
              Button({
                key: 'chat-' + l.id,
                label: name,
                plain: true,
                onPress: toggleChat(l.id),
              }),
              Text({ dimColor: true, children: [aligned ? ctxText(x).padEnd(ctxW) : ctxText(x)] }),
              Text({ dimColor: true, children: [aligned ? hitText(x).padEnd(hitW) : hitText(x)] }),
              Text({ color, dimColor: color === undefined, children: [aligned ? idleRight(x).padEnd(rightW) : idleRight(x)] }),
            ],
          }),
          Text({ children: [costText(x).padStart(costW)] }),
        ],
      })
      return idleOpen ? Box({ flexDirection: 'column', children: [row, chatDetail(l)] }) : row
    })
    const idleSummary =
      idleEntries.length === 0
        ? ''
        : idleEntries.length + ' idle' +
          (v.hideCache
            ? ''
            : ' · ' + liveIdle.length + ' with a live cache' + (nextLapse ? ' · next lapse ' + cut(nextLapse.l.name, 18) + ' ~' + untilText(nextLapse.left) : ''))
    const idleTotal = idleUsd > 0 ? '~' + money(idleUsd) : ''
    const idleSection =
      idleSummary === ''
        ? []
        : [
            Box({
              flexDirection: 'row',
              justifyContent: 'space-between',
              width: cols,
              children: [
                Text({ dimColor: true, children: [cut(idleSummary + (v.showIdle !== false ? '' : '  (i to list)'), Math.max(10, cols - idleTotal.length - 1))] }),
                Text({ children: [idleTotal] }),
              ],
            }),
          ].concat(v.showIdle !== false ? idleRows : [])

    const convoSection = Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          width: cols,
          children: [
            Text({ bold: true, children: ['Other chats · ' + workingCount + ' working'] }),
            Text({ children: [othersUsd > 0 ? 'total ~' + money(othersUsd) : ''] }),
          ],
        }),
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          width: cols,
          children: [
            Text({ dimColor: true, children: [busy.length + ' chats · ' + workingAgents + ' agents · ' + idle + ' idle'] }),
            Text({ children: [liveUsd > 0 ? 'working ~' + money(liveUsd) : ''] }),
          ],
        }),
      ].concat(
        liveRows.length > 0 ? liveRows : [Text({ dimColor: true, children: ['nothing else working (' + others.length + ' other sessions found)'] })],
        idleSection.length > 0 ? [Text({ children: [' '] })] : [],
        idleSection,
        convoError ? [Text({ color: 'red', wrap: 'wrap', children: ['scan problem: ' + convoError] })] : [],
      ),
    })

    const body =
      subs.length === 0
        ? [Text({ dimColor: true, children: ['No subagents in this chat.'] })]
        : blocks.length > 0
          ? blocks
          : [Text({ dimColor: true, children: ['Nothing matches the filter or search.'] })]

    // The footer sits at the bottom of the pane: the content grows to fill
    // whatever room the dock gives, and the footer follows it
    const bodyRows = e.props.scroll ? num(e.props.scroll.bodyRows) : 0
    const content = Box({
      flexDirection: 'column',
      flexGrow: 1,
      rowGap: 1,
      children: [Box({ flexDirection: 'column', children: summary })].concat(
        attention,
        subs.length > 0 ? search : [],
        [Box({ flexDirection: 'column', rowGap: 1, children: body })],
        agentsOnly ? [] : [convoSection],
        noUsage
          ? [Text({ color: 'yellow', children: [cut('⚠ model responses carry no token counts in this build', cols)] })]
          : [],
      ),
    })
    return Box({
      flexDirection: 'column',
      rowGap: 1,
      minHeight: bodyRows > 0 ? bodyRows : undefined,
      children: [content, footer],
    })
  })
}

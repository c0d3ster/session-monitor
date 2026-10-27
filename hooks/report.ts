import type { AgentRow, RunRecord, SessionRow, StatsRow } from '../types'
import { clock, costText, cut, fmt, money, seconds, tokenLine } from './format'
import { elapsed, ordered, statusWord } from './rows'
import { num } from './util'

export function toolCounts(row: AgentRow): string {
  const counts = row.byTool || {}
  return Object.keys(counts)
    .sort((a, b) => num(counts[b]) - num(counts[a]))
    .map(tool => tool + ' ×' + counts[tool])
    .join(' · ')
}

// One run as markdown: a table of its agents, then what each one did
export function runSection(rows: AgentRow[]): string[] {
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

export type RunStat = { at: number; prompt: string; agents: number; calls: number; tokens: number; usd: number; ms: number }

export function statOf(at: number, prompt: string, rows: AgentRow[]): RunStat {
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
export function comparison(rows: AgentRow[], history: RunRecord[], s: SessionRow): string[] {
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

export function reportsDir(home: string | undefined, cwd: string): string {
  return (home || cwd) + '/.claude/agent-reports'
}

export function historyText(history: RunRecord[], learned: StatsRow): string {
  return JSON.stringify({ runs: history, stats: learned })
}

export function csvCell(value: unknown): string {
  const text = String(value === undefined ? '' : value)
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

// Every agent of every run, one row each
export function buildCsv(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
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

export function buildJson(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
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

export function buildReport(rows: AgentRow[], history: RunRecord[], s: SessionRow): string {
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

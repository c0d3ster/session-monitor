import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, RunRecord, SessionRow, StatsRow, ViewRow } from '../types'

import { CACHE_TTL_MS, CONVO_WORKING_MS, LONG_MS, LOOP_AT, MAX_REPORT_VIEW, MAX_RUNS, MAX_TRANSCRIPT_BYTES, ORPHAN_MS, PANE, SHOW_LOG, WARN_CACHE_MS } from './constants'
import { bar, clock, clockText, cut, fileStamp, fmt, money, seconds, tokenLine, untilText } from './format'
import { LIMIT_NAMES, PLAN_COST_EVERY_MS, planCost } from './limits'
import { buildCsv, buildJson, buildReport, historyText, reportsDir, runSection } from './report'
import { RATES, addSession, addTokens, bumpTool, colorOf, dismissFinished, elapsed, isDone, isFailed, marker, matches, merge, ordered, progressOf, rollup, statusWord, summarize, upsert } from './rows'
import { alerted, flags, hidden, listedIds } from './state'
import { cacheStats, focusProbe, isBusy, latestNote, latestPrompt, live, liveExtra, mainTtlMs, subsOf, toolStats, ttlLabel, turnProgress, turnTools, usageStats, usdOf } from './transcripts'
import { isRecord, num, oneLine, parseJson, str } from './util'
import type { CacheInfo, Live, LiveExtra } from './transcripts'

// Written in an ES2017 (ES8) style where it can be: no object spread, no
// optional chaining, no nullish coalescing. The one exception is the
// `turn.step` hook, which Claude Code requires to be an async generator.

const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [] as AgentRow[])
const session = atom(
  { plugin: 'session-monitor', key: 'session' } as const,
  { tokIn: 0, tokOut: 0, tokCache: 0 } as SessionRow,
)
const view = atom({ plugin: 'session-monitor', key: 'view' } as const, {} as ViewRow)
const runs = atom({ plugin: 'session-monitor', key: 'runs' } as const, [] as RunRecord[])
const stats = atom({ plugin: 'session-monitor', key: 'stats' } as const, {} as StatsRow)

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
    if (!flags.historyLoaded) {
      flags.historyLoaded = true
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
      const eligible = live.sessions.filter(l => !l.spare && l.pid > 0)
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
        live.scans += 1
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
        if (!home) {
          live.convoError = 'no HOME or USERPROFILE'
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
        live.sessions = rows
        live.mine = myId
        live.convoError = ''

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
        live.convoError = String(err)
      } finally {
        scanning = false
      }
    })

    // Once a second: pull agent status and the context fill from the engine,
    // and redraw so run times and the cache countdown tick
    $.clock.every(1000, async () => {
      const infos = await $.agent.list()
      if (!flags.seeded) {
        // Agents that had already finished before this mod loaded belong to
        // an earlier run: keep them out
        flags.seeded = true
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
    // A subagent's report back to its parent is not work it did. The engine's
    // tool typings do not list the tool, so the name is compared as a string.
    const toolName: string = e.tool
    if (toolName === 'SubagentHandback') return next(e)
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
    const mine = live.sessions.filter(l => l.id === live.mine)[0]
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
      const own = liveExtra[live.mine]
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
    const others = live.sessions.filter(l => l.id !== live.mine)
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
        live.convoError ? [Text({ color: 'red', wrap: 'wrap', children: ['scan problem: ' + live.convoError] })] : [],
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

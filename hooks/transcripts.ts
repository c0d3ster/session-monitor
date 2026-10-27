import { CACHE_LOOKBACK, CACHE_TTL_1H_MS, CACHE_TTL_MS, CONVO_WORKING_MS } from './constants'
import { costOf } from './rows'
import { isRecord, num, parseJson, str } from './util'
import type { Usage } from './rows'

// A session the agents panel lists, read from ~/.claude/sessions and, for a
// background job, ~/.claude/jobs/<id>/state.json
export type Live = {
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

// What the last scan of ~/.claude/sessions found and how it went
export type LiveState = { sessions: Live[]; mine: string; convoError: string; scans: number }
export const live: LiveState = { sessions: [], mine: '', convoError: '', scans: 0 }

// What a chat's latest model request says about its prompt cache, read from
// its transcript. `ttlMs` is the lifetime the request's cache write used (1 hour
// or 5 minutes); `ttlKnown` is false when no recent write says, and the
// five-minute default stands in.
export type CacheInfo = {
  ctxTokens: number
  read: number
  wrote: number
  fresh: number
  hitPct: number
  lastAt: number
  ttlMs: number
  ttlKnown: boolean
}

export type LiveExtra = {
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

export const liveExtra: Record<string, LiveExtra> = {}

// Whether a window was found for a chat the last time it was looked for: a chat
// whose terminal was closed, or a job nothing is showing, has none to raise
export const focusProbe: Record<string, { ok: boolean; at: number }> = {}

// Working: the session file says so, or the transcript changed a moment ago. A
// chat that handed its work to a background job is not, whatever it last said.
export const isBusy = (l: Live, now: number): boolean => {
  if (l.handedTo !== '') return false
  if (l.busy) return true
  const changed = liveExtra[l.id]?.mtimeMs ?? 0
  return changed > 0 && now - changed < CONVO_WORKING_MS
}

export const subsOf = (id: string): number => liveExtra[id]?.subs ?? 0
export const usdOf = (id: string): number => liveExtra[id]?.usd ?? 0

export const toolStats = (text: string): { tools: number; lastTool: string } => {
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
export const promptText = (entry: Record<string, unknown>): string => {
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

export const latestPrompt = (text: string): string => {
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
export const turnTools = (text: string): number => {
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
export const turnProgress = (calls: number): number => Math.min(95, Math.round(100 * (1 - Math.exp(-num(calls) / 10))))

// Tokens and estimated cost for a whole transcript, summed from each reply's
// usage block. A reply can be written to the file more than once while it
// streams, so the last usage seen for each message id is the one counted.
export const usageStats = (text: string): { tokIn: number; tokOut: number; usd: number } => {
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
export const cacheStats = (text: string): CacheInfo | undefined => {
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
export const mainTtlMs = (): number => {
  const own = live.mine ? liveExtra[live.mine] : undefined
  return own && own.cache && own.cache.ttlKnown ? own.cache.ttlMs : CACHE_TTL_MS
}

export const ttlLabel = (ttlMs: number, known: boolean): string => (ttlMs >= CACHE_TTL_1H_MS ? '1h' : '5m') + (known ? '' : '?')

// What a session is doing right now, for chats that have no job file: the
// first line of its latest reply, else its latest tool call
export const latestNote = (text: string): string => {
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

export const projectLabel = (dir: string): string => {
  const parts = dir.split('-').filter(part => part.length > 0)
  return parts.length > 0 ? str(parts[parts.length - 1]) : dir
}

export const titleFrom = (text: string): string | undefined => {
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

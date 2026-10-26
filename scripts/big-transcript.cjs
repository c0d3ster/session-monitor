// What the pane needs from transcripts too big for the plugin API to read
// (over 4 MiB), taken from the END of each file: a transcript only grows at the
// end, and Claude Code rewrites a cost summary and the latest request there on
// every turn. No file is read whole.
//
//   node big-transcript.cjs '<json>'
//   json: { files: [{ id, path }], tail?: bytes (default 1 MiB), max?: bytes (default 4 MiB) }
//
// The window starts at `tail` bytes and grows a MiB at a time (up to `max`)
// until it holds both a model request and the latest typed prompt. Prints one
// line of JSON: { results: { id: { ok, size, partial, cache, turnTools, lastTool,
// note, usd, tokIn, tokOut, tokCache } | { ok: false, error } }, ms }.
const fs = require('fs')

const started = Date.now()
const spec = JSON.parse(process.argv[2] || '{}')
const files = Array.isArray(spec.files) ? spec.files : []
const TAIL = Number(spec.tail) > 0 ? Number(spec.tail) : 1048576
const MAX = Number(spec.max) > 0 ? Number(spec.max) : 4194304
const STEP = 1048576
const FIVE_MIN = 5 * 60 * 1000
const ONE_HOUR = 60 * 60 * 1000
const BIG_LINE = 500000

const num = x => (typeof x === 'number' && isFinite(x) ? x : 0)
const str = x => (typeof x === 'string' ? x : '')
const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)

const tryParse = line => {
  try {
    const parsed = JSON.parse(line)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// The last `bytes` of a file as whole lines (a line cut at the front is dropped)
const readTail = (path, size, bytes) => {
  const start = Math.max(0, size - bytes)
  const fd = fs.openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
      if (n <= 0) break
      got += n
    }
    let text = buf.toString('utf8', 0, got)
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    return { lines: text.split('\n'), whole: start === 0 }
  } finally {
    fs.closeSync(fd)
  }
}

const noteOf = entry => {
  const message = isRecord(entry.message) ? entry.message : undefined
  const content = message && Array.isArray(message.content) ? message.content : []
  for (let j = content.length - 1; j >= 0; j -= 1) {
    const block = content[j]
    if (!isRecord(block)) continue
    if (block.type === 'text' && str(block.text).trim()) return str(block.text).trim().split('\n')[0].slice(0, 200)
    if (block.type === 'tool_use') {
      const input = isRecord(block.input) ? block.input : {}
      const arg = str(input.description) || str(input.command) || str(input.file_path) || str(input.pattern) || str(input.url)
      return (str(block.name) + (arg ? ': ' + arg : '')).slice(0, 200)
    }
  }
  return ''
}

// The text of a typed prompt, as the pane shows it: a slash command reads as the
// command and its arguments; reminders and tags are dropped.
const promptText = entry => {
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

const scan = (lines, whole) => {
  let prompt = ''
  let cache
  let ttlMs = 0
  let cost
  let turnTools = 0
  let lastTool = ''
  let note = ''
  let boundary = false
  let seenUsage = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] || ''
    if (!line) continue
    const user = line.indexOf('"type":"user"') >= 0
    if (!prompt && user && line.indexOf('tool_result') < 0 && line.length < BIG_LINE) {
      const typed = tryParse(line)
      prompt = typed ? promptText(typed) : ''
    }
    if (!boundary) {
      const uses = line.split('"type":"tool_use"').length - 1
      if (uses > 0) {
        turnTools += uses
        if (!lastTool) {
          const found = line.slice(line.lastIndexOf('"type":"tool_use"')).match(/"name":"([^"]*)"/)
          if (found) lastTool = found[1]
        }
      }
      if (user && line.indexOf('tool_result') < 0) boundary = true
    }
    if (!cost && line.indexOf('"type":"cost-state"') >= 0) {
      const entry = tryParse(line)
      if (entry) cost = entry
      continue
    }
    if (line.length > BIG_LINE) continue
    if (seenUsage < 400 && line.indexOf('"usage"') >= 0) {
      const entry = tryParse(line)
      const message = entry && isRecord(entry.message) ? entry.message : undefined
      if (!entry || !message || !isRecord(message.usage)) continue
      seenUsage += 1
      const u = message.usage
      if (!cache) {
        const at = Date.parse(str(entry.timestamp))
        const read = num(u.cache_read_input_tokens)
        const wrote = num(u.cache_creation_input_tokens)
        const fresh = num(u.input_tokens)
        const total = read + wrote + fresh
        if (isFinite(at) && total > 0) {
          cache = { ctxTokens: total, read, wrote, fresh, hitPct: Math.round((read / total) * 100), lastAt: at, ttlMs: FIVE_MIN, ttlKnown: false }
          note = noteOf(entry)
        }
      }
      if (ttlMs === 0 && isRecord(u.cache_creation)) {
        if (num(u.cache_creation.ephemeral_1h_input_tokens) > 0) ttlMs = ONE_HOUR
        else if (num(u.cache_creation.ephemeral_5m_input_tokens) > 0) ttlMs = FIVE_MIN
      }
    }
  }
  if (cache && ttlMs > 0) {
    cache.ttlMs = ttlMs
    cache.ttlKnown = true
  }
  return { cache, cost, turnTools, lastTool, note, prompt, found: cache !== undefined && boundary, whole }
}

const totalsOf = cost => {
  if (!cost) return {}
  const out = { usd: num(cost.totalCostUSD), tokIn: 0, tokOut: 0, tokCache: 0 }
  const models = isRecord(cost.modelUsage) ? cost.modelUsage : {}
  Object.keys(models).forEach(name => {
    const m = models[name]
    if (!isRecord(m)) return
    out.tokIn += num(m.inputTokens) + num(m.cacheCreationInputTokens)
    out.tokOut += num(m.outputTokens)
    out.tokCache += num(m.cacheReadInputTokens)
  })
  return out
}

// Lifetime tool calls: every occurrence of the tool_use mark from `from` to the
// end of the file, counted in chunks that stop at a newline so a mark is never
// split. `from` is where the last count ended, so a growing file costs only what
// was appended. Returns the new total and the offset it covers.
const MARK = '"type":"tool_use"'
const CHUNK = 8 * 1048576
const countTools = (path, size, from, known) => {
  let at = from > 0 && from <= size ? from : 0
  let total = at > 0 ? known : 0
  const fd = fs.openSync(path, 'r')
  try {
    while (at < size) {
      const want = Math.min(CHUNK, size - at)
      const buf = Buffer.alloc(want)
      let got = 0
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, at + got)
        if (n <= 0) break
        got += n
      }
      if (got <= 0) break
      // Only whole lines: the last partial line is counted on the next read
      const end = at + got < size ? buf.lastIndexOf(10, got - 1) + 1 : got
      if (end <= 0) break
      total += buf.toString('utf8', 0, end).split(MARK).length - 1
      at += end
    }
  } finally {
    fs.closeSync(fd)
  }
  return { total, at }
}

const results = {}
files.forEach(file => {
  const id = str(file && file.id)
  const path = str(file && file.path)
  if (!id || !path) return
  try {
    const size = fs.statSync(path).size
    let bytes = TAIL
    let found
    for (;;) {
      const tail = readTail(path, size, bytes)
      found = scan(tail.lines, tail.whole)
      if (found.found || tail.whole || bytes >= MAX) break
      bytes += STEP
    }
    const counted = countTools(path, size, num(file.toolsAt), num(file.tools))
    results[id] = Object.assign(
      {
        ok: true,
        size,
        partial: !found.found,
        cache: found.cache,
        turnTools: found.turnTools,
        lastTool: found.lastTool,
        note: found.note,
        prompt: found.prompt,
        toolsTotal: counted.total,
        toolsAt: counted.at,
      },
      totalsOf(found.cost),
    )
  } catch (err) {
    results[id] = { ok: false, error: String(err && err.message ? err.message : err).slice(0, 120) }
  }
})

process.stdout.write(JSON.stringify({ results, ms: Date.now() - started }) + '\n')

// Estimated cost of every model reply in the transcripts under a projects
// folder, summed for each time window asked for. Streams each file line by
// line, so a transcript of any size is read (the plugin API stops at 4 MiB).
//
//   node window-cost.cjs <projectsDir> '<json>'
//   json: { windows: [{ name, start }], rates: [{ match, input, output }] }
//   start is a millisecond timestamp; rates are dollars per million tokens, and
//   a model that matches none is priced like the last entry.
// Prints one line of JSON: { windows: { name: { usd, tokens } }, files, bytes, ms }.
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const started = Date.now()
const dir = process.argv[2]
const spec = JSON.parse(process.argv[3] || '{}')
const windows = Array.isArray(spec.windows) ? spec.windows : []
const rates = (Array.isArray(spec.rates) ? spec.rates : []).map(r => ({ re: new RegExp(r.match, 'i'), input: r.input, output: r.output }))
const fallback = { input: 3, output: 15 }
const earliest = windows.reduce((min, w) => Math.min(min, w.start), Infinity)

const num = x => (typeof x === 'number' && isFinite(x) ? x : 0)

const walk = root => {
  const out = []
  const visit = d => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    entries.forEach(entry => {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) return visit(full)
      if (!entry.name.endsWith('.jsonl')) return
      try {
        const stat = fs.statSync(full)
        if (stat.mtimeMs >= earliest) out.push({ full, size: stat.size })
      } catch {
        // gone between listing and stat
      }
    })
  }
  visit(root)
  return out
}

// One reply can be written to a transcript several times while it streams, and
// a resumed session repeats the replies of the one before it: the last usage
// seen for each message id is the one counted, across all files
const replies = new Map()

const readFile = file =>
  new Promise(resolve => {
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    lines.on('line', line => {
      if (line.indexOf('"usage"') < 0) return
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      const message = entry && entry.message
      if (!message || !message.usage || typeof message.usage !== 'object') return
      const at = Date.parse(entry.timestamp)
      if (!isFinite(at)) return
      const id = typeof message.id === 'string' && message.id ? message.id : file + ':' + replies.size
      replies.set(id, { at, model: typeof message.model === 'string' ? message.model : '', usage: message.usage })
    })
    lines.on('close', resolve)
    lines.on('error', resolve)
  })

const costOf = (model, u) => {
  const rate = rates.filter(r => r.re.test(model))[0] || fallback
  return (
    (num(u.input_tokens) * rate.input +
      num(u.cache_creation_input_tokens) * rate.input * 1.25 +
      num(u.cache_read_input_tokens) * rate.input * 0.1 +
      num(u.output_tokens) * rate.output) /
    1000000
  )
}

const main = async () => {
  const files = walk(dir)
  for (const file of files) await readFile(file.full)
  const totals = {}
  windows.forEach(w => {
    totals[w.name] = { usd: 0, tokens: 0 }
  })
  replies.forEach(reply => {
    const usd = costOf(reply.model, reply.usage)
    const tokens = num(reply.usage.input_tokens) + num(reply.usage.output_tokens) + num(reply.usage.cache_creation_input_tokens) + num(reply.usage.cache_read_input_tokens)
    windows.forEach(w => {
      if (reply.at < w.start) return
      totals[w.name].usd += usd
      totals[w.name].tokens += tokens
    })
  })
  process.stdout.write(JSON.stringify({ windows: totals, files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0), ms: Date.now() - started }) + '\n')
}

main().catch(err => {
  process.stderr.write(String(err && err.message ? err.message : err) + '\n')
  process.exit(1)
})

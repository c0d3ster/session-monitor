// Brings the window that hosts a Claude Code chat to the front, on Windows,
// macOS and Linux.
//
//   node focus-window.cjs <pid> [--cwd <folder>] [--viewer-of <job id>] [--dry]
//   node focus-window.cjs --probe '[{"id","pid","jobId"?}]'   (see below)
//
// A background job runs in a hidden pty host with no window. With --viewer-of
// the window raised is the one of the terminal showing that job: a
// `claude attach <job id>` process, or else a `claude agents` dashboard (which
// lists every job). <pid> is then ignored.
//
// Walks up from the chat's process to the first ancestor that owns a window,
// then raises it. An editor like Cursor keeps one window per workspace under
// one process, so with --cwd the window whose title names a folder of the
// chat's directory (deepest first) is the one raised. --dry only reports what
// it found. Prints one line of JSON:
// { ok, host?, title?, how?, error? }.
//
//   Windows  scripts/focus-window.ps1 (user32), window level
//   macOS    System Events by unix id; Terminal.app and iTerm2 also pick the
//            tab by its tty
//   Linux    xdotool or wmctrl on X11; Wayland does not let one app raise
//            another's window, so it says so
//
// Several chats in one terminal window share it: the window is raised, and
// the tab is picked only where the terminal exposes it (macOS Terminal.app and
// iTerm2). The macOS and Linux paths have not been run on those systems.
const { execFileSync } = require('child_process')
const path = require('path')

let pid = Number.parseInt(process.argv[2] || '', 10)
const dry = process.argv.includes('--dry')
const viewerAt = process.argv.indexOf('--viewer-of')
const viewerOf = viewerAt > 0 ? process.argv[viewerAt + 1] || '' : ''
const cwdAt = process.argv.indexOf('--cwd')
const cwd = cwdAt > 0 ? process.argv[cwdAt + 1] || '' : ''
// The chat's folders, deepest first
const folders = cwd.split(/[\/]+/).filter(Boolean).reverse()

// Of several window titles, the index of the one that names the deepest folder
// of the chat's directory ("file - folder - Editor"), or -1
const pickByFolder = titles => {
  for (const folder of folders) {
    let at = titles.findIndex(title => title.split(' - ').includes(folder))
    if (at < 0) at = titles.findIndex(title => title.includes(folder))
    if (at >= 0) return at
  }
  return -1
}

const out = result => {
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(0)
}

const run = (cmd, args, timeout) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: timeout || 8000, stdio: ['ignore', 'pipe', 'ignore'] })

const tryRun = (cmd, args) => {
  try {
    return run(cmd, args)
  } catch {
    return undefined
  }
}

// The process and its parents, nearest first (ps knows them on macOS and Linux)
const chainOf = start => {
  const chain = []
  let current = start
  for (let depth = 0; depth < 16 && current > 1; depth += 1) {
    const parent = Number.parseInt((tryRun('ps', ['-o', 'ppid=', '-p', String(current)]) || '').trim(), 10)
    if (!Number.isFinite(parent) || parent <= 1) break
    chain.push(parent)
    current = parent
  }
  return chain
}

const NOT_FOUND = 'no window found for this chat (background chats have none, and a terminal that was closed or reparented cannot be traced)'

const quote = text => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const windows = () => {
  const script = path.join(__dirname, 'focus-window.ps1')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid)].concat(cwd ? ['-Cwd', cwd] : [], dry ? ['-DryRun'] : [])
  const line = run('powershell.exe', args, 15000).trim().split('\n').pop() || ''
  process.stdout.write(line + '\n')
  process.exit(0)
}

const mac = () => {
  const tty = (tryRun('ps', ['-o', 'tty=', '-p', String(pid)]) || '').trim()
  for (const ancestor of chainOf(pid)) {
    // A GUI app is a System Events process with a window, found by unix id
    const name = (tryRun('osascript', ['-e', 'tell application "System Events" to get name of (first process whose unix id is ' + ancestor + ' and background only is false)']) || '').trim()
    if (!name) continue
    if (dry) out({ ok: true, dryRun: true, host: name, title: '' })
    // The terminals that script their tabs: select the one on this chat's tty
    if (tty && tty !== '??') {
      const dev = '/dev/' + tty
      const picks = {
        Terminal:
          'tell application "Terminal"\nrepeat with w in windows\nrepeat with t in tabs of w\nif tty of t is ' + quote(dev) + ' then\nset selected of t to true\nset index of w to 1\nactivate\nreturn "tab"\nend if\nend repeat\nend repeat\nend tell\nreturn ""',
        iTerm2:
          'tell application "iTerm2"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif tty of s is ' + quote(dev) + ' then\nselect t\nselect s\nactivate\nreturn "tab"\nend if\nend repeat\nend repeat\nend repeat\nend tell\nreturn ""',
      }
      const pick = picks[name === 'iTerm2' || name === 'iTerm' ? 'iTerm2' : name]
      if (pick && (tryRun('osascript', ['-e', pick]) || '').trim() === 'tab') out({ ok: true, host: name, how: 'tab' })
    }
    run('osascript', ['-e', 'tell application "System Events" to set frontmost of (first process whose unix id is ' + ancestor + ') to true'])
    // An editor with a window per workspace: raise the one named for the chat's folder
    const names = (tryRun('osascript', ['-e', 'tell application "System Events" to get name of every window of (first process whose unix id is ' + ancestor + ')']) || '')
      .trim()
      .split(', ')
      .filter(Boolean)
    const at = pickByFolder(names)
    if (at >= 0) {
      tryRun('osascript', ['-e', 'tell application "System Events" to tell (first process whose unix id is ' + ancestor + ') to perform action "AXRaise" of (first window whose name is ' + quote(names[at]) + ')'])
      out({ ok: true, host: name, title: names[at], how: 'window', windows: names.length, matched: true })
    }
    out({ ok: true, host: name, how: 'app', windows: names.length, matched: false })
  }
  out({ ok: false, error: NOT_FOUND })
}

const linux = () => {
  if (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY) {
    out({ ok: false, error: 'Wayland does not let one app raise another window; run the chat under X11 or focus it yourself' })
  }
  const chain = chainOf(pid)
  const hasXdotool = tryRun('xdotool', ['version']) !== undefined
  const hasWmctrl = tryRun('wmctrl', ['-m']) !== undefined
  if (!hasXdotool && !hasWmctrl) out({ ok: false, error: 'install xdotool or wmctrl to focus windows' })
  for (const ancestor of chain) {
    // Every window the process owns: { id, title }
    let owned = []
    if (hasXdotool) {
      owned = (tryRun('xdotool', ['search', '--onlyvisible', '--pid', String(ancestor)]) || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(wid => ({ id: wid, title: (tryRun('xdotool', ['getwindowname', wid]) || '').trim() }))
    } else {
      // "0x03a00007  0 <pid> host title"
      owned = (tryRun('wmctrl', ['-lp']) || '')
        .split('\n')
        .map(l => l.trim().split(/\s+/))
        .filter(parts => parts[2] === String(ancestor))
        .map(parts => ({ id: parts[0], title: parts.slice(4).join(' ') }))
    }
    if (owned.length === 0) continue
    const at = pickByFolder(owned.map(w => w.title))
    const chosen = at >= 0 ? owned[at] : owned[owned.length - 1]
    const id = chosen.id
    const title = chosen.title
    const host = (tryRun('ps', ['-o', 'comm=', '-p', String(ancestor)]) || '').trim()
    if (dry) out({ ok: true, dryRun: true, host, title, windows: owned.length, matched: at >= 0 })
    if (hasXdotool) run('xdotool', ['windowactivate', id])
    else run('wmctrl', ['-ia', id])
    out({ ok: true, host, title, how: 'window', windows: owned.length, matched: at >= 0 })
  }
  out({ ok: false, error: NOT_FOUND })
}

// --probe '<json>': for many chats at once, whether a window can be found for
// each, from one look at the process table. json: [{ id, pid, jobId? }].
// Prints { results: { id: { ok } } }. A chat with a jobId is a background job:
// its window is the one of the terminal showing it. Windows reads the process
// table and the window-owning processes in a single PowerShell call; elsewhere
// each chat is asked on its own.
const SKIP = ['explorer', 'svchost', 'services', 'wininit', 'winlogon', 'system', 'idle']

const probeWindows = items => {
  const script = [
    '$w = @{}',
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $w[$_.Id] = $_.ProcessName }',
    'Write-Output ("W " + (($w.Keys | ForEach-Object { "$_=$($w[$_])" }) -join ","))',
    'Get-CimInstance Win32_Process | ForEach-Object { Write-Output "P $($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }',
  ].join('; ')
  const listing = run('powershell.exe', ['-NoProfile', '-Command', script], 25000)
  const parentOf = {}
  const windowOwners = {}
  const claudes = []
  for (const line of listing.split('\n')) {
    if (line.startsWith('W ')) {
      for (const pair of line.slice(2).trim().split(',')) {
        const [id, name] = pair.split('=')
        if (id) windowOwners[id] = (name || '').toLowerCase()
      }
    } else if (line.startsWith('P ')) {
      const match = line.slice(2).trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      if (!match) continue
      parentOf[match[1]] = match[2]
      if (match[3].toLowerCase() === 'claude.exe') claudes.push({ pid: match[1], args: match[4] })
    }
  }
  const viewerOfJob = jobId => {
    const wanted = String(jobId).replace(/[^a-zA-Z0-9-]/g, '')
    let best
    for (const proc of claudes) {
      if (proc.args.includes('--bg-pty-host')) continue
      const attached = /\battach\s+["']?([\w-]+)/.exec(proc.args)
      const rank = attached && wanted !== '' && attached[1].startsWith(wanted) ? 1 : /\bagents\b/.test(proc.args) ? 2 : 0
      if (rank > 0 && (!best || rank < best.rank)) best = { rank, pid: proc.pid }
    }
    return best ? best.pid : undefined
  }
  const results = {}
  for (const item of items) {
    let start = item.jobId ? viewerOfJob(item.jobId) : String(item.pid)
    let ok = false
    if (start && parentOf[start] !== undefined) {
      let current = parentOf[start]
      for (let depth = 0; depth < 16 && current && parentOf[current] !== undefined; depth += 1) {
        const host = windowOwners[current]
        if (host !== undefined && !SKIP.includes(host)) {
          ok = true
          break
        }
        current = parentOf[current]
      }
    }
    results[item.id] = { ok }
  }
  return results
}

const probe = () => {
  let items = []
  try {
    items = JSON.parse(process.argv[3] || '[]')
  } catch {
    out({ ok: false, error: 'bad probe list' })
  }
  if (process.platform === 'win32') out({ ok: true, results: probeWindows(items) })
  const results = {}
  for (const item of items) {
    const args = [__filename, String(item.pid), '--dry'].concat(item.jobId ? ['--viewer-of', String(item.jobId)] : [])
    const line = (tryRun('node', args) || '').trim().split('\n').pop() || ''
    let ok = false
    try {
      ok = JSON.parse(line).ok === true
    } catch {
      // no answer: no window
    }
    results[item.id] = { ok }
  }
  out({ ok: true, results })
}

// The terminal client showing a background job: "claude attach <id>" first,
// then a "claude agents" dashboard. The pty host that runs the job is not one.
const findViewer = jobId => {
  const listing =
    process.platform === 'win32'
      ? tryRun('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"])
      : tryRun('ps', ['-eo', 'pid=,args='])
  let best
  const wanted = jobId.replace(/[^a-zA-Z0-9-]/g, '')
  for (const line of (listing || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match || match[2].includes('--bg-pty-host')) continue
    const args = match[2]
    const attached = /\battach\s+["']?([\w-]+)/.exec(args)
    const rank = attached && wanted !== '' && attached[1].startsWith(wanted) ? 1 : /\bagents\b/.test(args) ? 2 : 0
    if (rank > 0 && (!best || rank < best.rank)) best = { rank, pid: Number(match[1]) }
  }
  return best ? best.pid : undefined
}
if (process.argv[2] === '--probe') probe()
if (viewerOf) {
  const viewer = findViewer(viewerOf)
  if (!viewer) out({ ok: false, error: 'no terminal is showing this job (claude attach ' + viewerOf + ' opens it)' })
  pid = viewer
}
if (!Number.isFinite(pid) || pid <= 0) out({ ok: false, error: 'no process id' })
try {
  if (process.platform === 'win32') windows()
  else if (process.platform === 'darwin') mac()
  else linux()
} catch (err) {
  out({ ok: false, error: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 160) })
}

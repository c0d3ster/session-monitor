import type { AgentSpawnInput, CommandRunInput, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The full inputs the engine hands a hook, so a test names only what it cares about
const commandInput = (command: string): CommandRunInput => ({
  command,
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
})

const spawnInput = (prompt: string, description: string, subagentType: string): AgentSpawnInput => ({
  tool_use_id: 'toolu-test',
  prompt,
  description,
  subagentType,
  provider: { plugin: 'session-monitor', tier: 'user' },
  parentModel: 'sonnet',
  background: false,
  fork: false,
})

// `tool.call` drops `agentId` and `tool_use_id` when they ride along, and the
// engine tags the call with them. Passing a named value, not a fresh object
// literal, is how the extra key gets past the excess property check.
const taggedCall = <const T extends { tool: string; agentId: string }>(call: T): T => call

const PANE = {
  plugin: 'session-monitor',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-monitor',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  viewport: { columns: 100, rows: 30 },
} as const

test('/session-monitor opens the pane', async ($, on) => {
  let opened = ''
  on('ui.open', (_$, e) => {
    opened = (e as unknown as { id: string }).id
    return { value: { isPlaced: true } }
  })
  await $.command.run(commandInput('session-monitor'))
  expect(opened).toBe('session-monitor')
})

test('/agent-monitor opens the same pane with agents only, and /session-monitor brings the rest back', async ($, on) => {
  let opened = ''
  on('ui.open', (_$, e) => {
    opened = (e as unknown as { id: string }).id
    return { value: { isPlaced: true } }
  })
  await $.command.run(commandInput('agent-monitor'))
  expect(opened).toBe('session-monitor')

  const agentsView = await $.ui.mount(PANE)
  expect((await agentsView.find({ type: 'Text', text: /Other chats/ })) === undefined).toBe(true)
  expect((await agentsView.find({ type: 'Text', text: /My Plan/ })) === undefined).toBe(true)
  expect((await agentsView.find({ type: 'Button', text: /Idle chats/ })) === undefined).toBe(true)
  expect((await agentsView.find({ type: 'Button', text: /View: agents/ })) === undefined).toBe(false)
  expect((await agentsView.find({ type: 'Text', text: /No subagents in this chat/ })) === undefined).toBe(false)
  await agentsView.unmount()

  await $.command.run(commandInput('session-monitor'))
  const fullView = await $.ui.mount(PANE)
  expect((await fullView.find({ type: 'Text', text: /Other chats/ })) === undefined).toBe(false)
  expect((await fullView.find({ type: 'Button', text: /Idle chats/ })) === undefined).toBe(false)
  expect((await fullView.find({ type: 'Button', text: /View: full/ })) === undefined).toBe(false)
  await fullView.unmount()
})

test('the View button switches between the full pane and agents only', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Other chats/ })) === undefined).toBe(false)
  await ui.press({ key: 'scope-toggle' })
  expect((await ui.find({ type: 'Text', text: /Other chats/ })) === undefined).toBe(true)
  await ui.press({ key: 'scope-toggle' })
  expect((await ui.find({ type: 'Text', text: /Other chats/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('with no subagents the pane shows the summary and an empty state', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Agents/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /session in – · out – · total –/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^cache\s+–/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /No subagents in this chat/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('a running subagent shows an estimated progress bar and its tool calls', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.agent.spawn(spawnInput('look around', 'map the repo', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))
  await $.tool.call(taggedCall({ tool: 'Read', file_path: 'README.md', agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  // The agent's name is a button: pressing it opens what the agent did
  expect((await ui.find({ key: 'open-agent-1' })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /~\d+%/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /2 calls/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /estimated from tool calls/ })) === undefined).toBe(false)
  // Tokens have not been reported yet: a dash placeholder, never NaN
  expect((await ui.find({ type: 'Text', text: /in – · out – · total –/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('pressing an agent name shows what it did', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.agent.spawn(spawnInput('find the TODOs in src', 'todo hunt', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /find the TODOs in src/ })) === undefined).toBe(true)
  await ui.press({ key: 'open-agent-1' })
  expect((await ui.find({ type: 'Text', text: /find the TODOs in src/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^Grep$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /TODO/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('/agent-report opens the pane', async ($, on) => {
  let opened = ''
  on('ui.open', (_$, e) => {
    opened = (e as unknown as { id: string }).id
    return { value: { isPlaced: true } }
  })
  await $.command.run(commandInput('agent-report'))
  expect(opened).toBe('session-monitor')
})

test('the report view has Back, Copy and Save and lists tool counts', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.agent.spawn(spawnInput('find the TODOs', 'todo hunt', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))
  await $.command.run(commandInput('agent-report'))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Back/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Button', text: /Copy/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Button', text: /Save/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Markdown', text: /Grep/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a tool error puts the agent under Needs attention', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'nope', text: 'permission denied', isError: true }))

  await $.agent.spawn(spawnInput('read secrets', 'secret reader', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Read', file_path: '/etc/shadow', agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Needs attention/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /1 error/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /permission denied/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('the filter button cycles and search narrows the agents', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.agent.spawn(spawnInput('find the TODOs', 'todo hunt', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'search' })) === undefined).toBe(false)
  await ui.press({ key: 'filter' })
  expect((await ui.find({ type: 'Button', text: /Show: running/ })) === undefined).toBe(false)
  await ui.press({ key: 'filter' })
  expect((await ui.find({ type: 'Text', text: /Nothing matches/ })) === undefined).toBe(false)
  await ui.press({ key: 'filter' })
  expect((await ui.find({ key: 'open-agent-1' })) === undefined).toBe(false)
  await ui.unmount()
})

test('the report offers JSON and CSV and notes its token sources', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run(commandInput('agent-report'))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'json' })) === undefined).toBe(false)
  expect((await ui.find({ key: 'csv' })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Markdown', text: /model responses/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('the pane lists conversations', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /\d+ working/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('the idle chats toggle lists and hides them', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Idle chats: shown/ })) === undefined).toBe(false)
  await ui.press({ key: 'idle-toggle' })
  expect((await ui.find({ type: 'Button', text: /Idle chats: hidden/ })) === undefined).toBe(false)
  await ui.press({ key: 'idle-toggle' })
  expect((await ui.find({ type: 'Button', text: /Idle chats: shown/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('the cache info can be hidden and shown again', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Cache info: shown/ })) === undefined).toBe(false)
  await ui.press({ key: 'cache-toggle' })
  expect((await ui.find({ type: 'Button', text: /Cache info: hidden/ })) === undefined).toBe(false)
  await ui.press({ key: 'cache-toggle' })
  expect((await ui.find({ type: 'Button', text: /Cache info: shown/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('the footer still shows when the dock gives the pane a fixed height', async ($) => {
  const tall = Object.assign({}, PANE, {
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { bodyRows: 40 } } as never,
  })
  const ui = await $.ui.mount(tall)
  expect((await ui.find({ key: 'report' })) === undefined).toBe(false)
  expect((await ui.find({ key: 'cache-toggle' })) === undefined).toBe(false)
  await ui.unmount()
})

test('the top of the pane is headed as this session', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^This session/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('with no usage limits reported the pane draws no limit rows and no NaN', async ($) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /limit/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a tool call tagged with an agent id nobody spawned does not leave a row behind', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call(taggedCall({ tool: 'Bash', command: 'echo noop', agentId: 'a4809038' }))
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /a4809038/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /NaN/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a subagent handing its report back is not counted as a tool call', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.agent.spawn(spawnInput('look around', 'map the repo', 'Explore'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))
  // Not in the engine's tool typings, but it reaches `tool.call` at runtime
  const handback = taggedCall({ tool: 'SubagentHandback', agentId: 'agent-1' })
  await $.tool.call(handback as never)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /1 calls?\b/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /2 calls/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /SubagentHandback/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('Show and Clear finished sit under the agents, only when there are agents, and Clear appears once one is done', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn(spawnInput('find the TODOs', 'todo hunt', 'Explore'))
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'filter' })) === undefined).toBe(false)
  expect((await ui.find({ key: 'clear' })) === undefined).toBe(true)
  await ui.unmount()

  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'clear' })) === undefined).toBe(false)
  await ui.press({ key: 'clear' })
  expect((await ui.find({ key: 'open-agent-1' })) === undefined).toBe(true)
  expect((await ui.find({ key: 'clear' })) === undefined).toBe(true)
  // No agents left, so no Show either
  expect((await ui.find({ key: 'filter' })) === undefined).toBe(true)
  await ui.unmount()
})

// Not in the engine's tool typings (it is this plugin's own), so the calls go in as `never`
const stepCall = (fields: { done: number; total?: number; note?: string; agentId?: string }): never =>
  Object.assign({ tool: 'mcp__session-monitor__step' }, fields) as never

test('a worker reports its steps and gets an acknowledgement', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.agent.spawn(spawnInput('refactor the parser', 'refactor parser', 'general-purpose'))

  const first = await $.tool.call(stepCall({ done: 0, total: 5, note: 'reading the parser', agentId: 'agent-1' }))
  expect(String(first.result)).toBe('ok: 0/5')
  // total is kept when a later report leaves it out, and done cannot pass it
  const later = await $.tool.call(stepCall({ done: 9, agentId: 'agent-1' }))
  expect(String(later.result)).toBe('ok: 5/5')
})

test('a step report from the main session or an unknown agent changes nothing', async ($, on) => {
  on('tool.call', () => ({ result: 'unhandled' }))
  const main = await $.tool.call(stepCall({ done: 1, total: 3 }))
  expect(String(main.result).startsWith('ignored')).toBe(true)
  const stranger = await $.tool.call(stepCall({ done: 1, total: 3, agentId: 'nobody' }))
  expect(String(stranger.result).startsWith('ignored')).toBe(true)
})

test('a step report is not counted as a tool call', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.agent.spawn(spawnInput('look around', 'map the repo', 'general-purpose'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))
  await $.tool.call(stepCall({ done: 1, total: 2, agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /1 calls?\b/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /2 calls/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a savvy-progress step report feeds the bar and is not counted as a tool call', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.agent.spawn(spawnInput('look around', 'map the repo', 'general-purpose'))
  await $.tool.call(taggedCall({ tool: 'Grep', pattern: 'TODO', agentId: 'agent-1' }))
  await $.tool.call(
    Object.assign({ tool: 'mcp__savvy-progress__step' }, { done: 1, total: 4, note: 'mapping', agentId: 'agent-1' }) as never,
  )

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^1\/4 steps$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /1 calls?\b/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /2 calls/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('an agent that reports steps shows a real bar, and one that does not keeps the estimate', async ($, on) => {
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-' + ++n }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.agent.spawn(spawnInput('refactor the parser', 'refactor parser', 'general-purpose'))
  await $.agent.spawn(spawnInput('write the docs', 'write docs', 'general-purpose'))
  await $.tool.call(stepCall({ done: 2, total: 5, note: 'reading the parser', agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  // Reported: no tilde, the step count, and the step in progress
  expect((await ui.find({ type: 'Text', text: /^40%$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^2\/5 steps$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /now: reading the parser/ })) === undefined).toBe(false)
  // Not reported: the estimate, marked with a tilde
  expect((await ui.find({ type: 'Text', text: /^~\d+%$/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('reported progress stops short of 100% until the agent finishes', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn(spawnInput('refactor the parser', 'refactor parser', 'general-purpose'))
  await $.tool.call(stepCall({ done: 5, total: 5, agentId: 'agent-1' }))

  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^99%$/ })) === undefined).toBe(false)
  await ui.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn-1', agentId: 'agent-1', reason: 'answer' })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^99%$/ })) === undefined).toBe(true)
  await ui.unmount()
})

// Records the prompt the engine would run each subagent with, after this
// plugin's hook. Hooks beneath the plugin must be registered before the first
// call on `$`, so it is installed once per test.
const watchSpawns = (on: On): { prompts: string[] } => {
  const watch: { prompts: string[] } = { prompts: [] }
  on('agent.spawn', (_$, e) => {
    watch.prompts.push(e.prompt)
    return { model: 'haiku', agentId: 'agent-' + watch.prompts.length }
  })
  return watch
}

const LONG = 'Refactor the parser so that it reads tokens lazily. '.repeat(6)

test('a real task gets the reporting line after its original text', async ($, on) => {
  const watch = watchSpawns(on)
  await $.agent.spawn(spawnInput(LONG, 'refactor parser', 'general-purpose'))
  const sent = watch.prompts[0] || ''
  expect(sent.startsWith(LONG)).toBe(true)
  expect(sent.includes('mcp__session-monitor__step')).toBe(true)
})

test('lookup agents, short prompts and prompts that already name a step tool are left alone', async ($, on) => {
  const watch = watchSpawns(on)
  const briefed = LONG + ' Report with mcp__other__step as you go.'
  await $.agent.spawn(spawnInput(LONG, 'map the repo', 'Explore'))
  await $.agent.spawn(spawnInput('find the TODOs', 'todo hunt', 'general-purpose'))
  await $.agent.spawn(spawnInput(briefed, 'already briefed', 'general-purpose'))
  expect(watch.prompts).toEqual([LONG, 'find the TODOs', briefed])
})

test('with stepReports off no prompt is touched', { options: { stepReports: 'off' } }, async ($, on) => {
  const watch = watchSpawns(on)
  await $.agent.spawn(spawnInput(LONG, 'refactor parser', 'general-purpose'))
  expect(watch.prompts).toEqual([LONG])
})

// The plan tool is this plugin's own too, so its calls also go in as `never`
type PlanTaskInput = { id: string; title?: string; tier?: string; dependsOn?: string[]; status?: string }
const planCall = (fields: { title?: string; phase?: string; tasks?: PlanTaskInput[]; agentId?: string }): never =>
  Object.assign({ tool: 'mcp__session-monitor__plan' }, fields) as never

test('the main session posts a plan and gets it back as an acknowledgement', async ($, on) => {
  on('tool.call', () => ({ result: 'unhandled' }))
  const posted = await $.tool.call(
    planCall({
      title: 'ship 0.5.0',
      phase: 'plan',
      tasks: [
        { id: 't1', title: 'plan tool', tier: 'medium' },
        { id: 't2', title: 'flow bar', dependsOn: ['t1'] },
      ],
    }),
  )
  expect(String(posted.result)).toBe('ok: "ship 0.5.0", phase plan, 2 tasks (0 done)')
})

test('tasks are matched by id, so a rename keeps the task and its status', async ($, on) => {
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.tool.call(planCall({ title: 'ship 0.5.0', phase: 'tasks', tasks: [{ id: 't1', title: 'plan tool' }, { id: 't2', title: 'flow bar' }] }))
  await $.tool.call(planCall({ tasks: [{ id: 't1', status: 'done' }] }))
  const renamed = await $.tool.call(planCall({ tasks: [{ id: 't1', title: 'plan tool, renamed' }] }))
  // Still two tasks, t1 still done, and the title and phase are kept
  expect(String(renamed.result)).toBe('ok: "ship 0.5.0", phase tasks, 2 tasks (1 done)')
})

test('a new title starts a new plan, and bad fields are dropped', async ($, on) => {
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.tool.call(planCall({ title: 'first flow', phase: 'review', tasks: [{ id: 't1' }, { id: 't2' }] }))
  const second = await $.tool.call(planCall({ title: 'second flow', phase: 'nonsense', tasks: [{ id: 'a' }, { id: '' }, { id: 'b', status: 'bogus' }] }))
  expect(String(second.result)).toBe('ok: "second flow", phase none, 2 tasks (0 done)')
})

test('a worker cannot post or change the plan', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.agent.spawn(spawnInput('refactor the parser', 'refactor parser', 'general-purpose'))
  await $.tool.call(planCall({ title: 'real plan', tasks: [{ id: 't1' }] }))
  const worker = await $.tool.call(planCall({ title: 'worker plan', tasks: [{ id: 'x' }], agentId: 'agent-1' }))
  expect(String(worker.result).startsWith('ignored')).toBe(true)
  const after = await $.tool.call(planCall({}))
  expect(String(after.result)).toBe('ok: "real plan", phase none, 1 task (0 done)')
})

test('a run carrying [task:id] drives its task, and a rename keeps the match', async ($, on) => {
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-' + ++n }))
  on('tool.call', () => ({ result: 'unhandled' }))
  on('turn.complete', () => ({ text: '' }))
  await $.tool.call(planCall({ title: 'ship it', phase: 'tasks', tasks: [{ id: 't1', title: 'plan tool' }, { id: 't2', title: 'flow bar' }] }))
  await $.agent.spawn(spawnInput('build the plan tool', '[task:t1] plan tool', 'general-purpose'))
  await $.agent.spawn(spawnInput('unrelated [task: t2 ] work', 'flow bar', 'general-purpose'))

  // Both running, none done; the marker is not part of the agent's name
  expect(String((await $.tool.call(planCall({}))).result)).toBe('ok: "ship it", phase tasks, 2 tasks (0 done)')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /\[task:/ })) === undefined).toBe(true)
  await ui.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn-1', agentId: 'agent-1', reason: 'answer' })
  const renamed = await $.tool.call(planCall({ tasks: [{ id: 't1', title: 'plan tool, renamed' }] }))
  expect(String(renamed.result)).toBe('ok: "ship it", phase tasks, 2 tasks (1 done)')
})

test('a verdict the orchestrator posts wins over the run', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.tool.call(planCall({ title: 'ship it', tasks: [{ id: 't1' }] }))
  await $.agent.spawn(spawnInput('build it', '[task:t1] build', 'general-purpose'))
  // Still running, but the orchestrator accepted it
  const accepted = await $.tool.call(planCall({ tasks: [{ id: 't1', status: 'done' }] }))
  expect(String(accepted.result)).toBe('ok: "ship it", phase none, 1 task (1 done)')
})

test('the pane shows the plan: flow bar, every task, and progress once a task runs', async ($, on) => {
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-' + ++n }))
  on('tool.call', () => ({ result: 'unhandled' }))
  await $.tool.call(
    planCall({
      title: 'ship it',
      phase: 'tasks',
      tasks: [
        { id: 't1', title: 'plan tool', tier: 'medium', status: 'done' },
        { id: 't2', title: 'flow bar', tier: 'heavy' },
        { id: 't3', title: 'skill', dependsOn: ['t2'] },
      ],
    }),
  )
  await $.agent.spawn(spawnInput('draw the bar', '[task:t2] flow bar', 'general-purpose'))
  await $.tool.call(stepCall({ done: 1, total: 4, agentId: 'agent-1' }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^Plan$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^1\/3 done$/ })) === undefined).toBe(false)
  // The flow bar: Plan and Design behind, Tasks current with its count, the rest ahead
  expect((await ui.find({ type: 'Text', text: /^✓ Plan$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: / › Tasks 1\/3$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: / › Review$/ })) === undefined).toBe(false)
  // Each task: planned, running with its reported progress, waiting on a dependency
  expect((await ui.find({ type: 'Text', text: /^plan tool \[medium\]$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^flow bar \[heavy\] 25%$/ })) === undefined).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^skill · after t2$/ })) === undefined).toBe(false)
  await ui.unmount()
})

test('with no plan posted the pane has no Plan section', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  await $.agent.spawn(spawnInput('look around', 'map the repo', 'general-purpose'))
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^Plan$/ })) === undefined).toBe(true)
  await ui.unmount()
})

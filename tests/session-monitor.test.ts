import type { AgentSpawnInput, CommandRunInput } from 'claude-code'
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

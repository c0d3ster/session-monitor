import type { AgentRow, Phase, PlanRow, PlanTask, TaskStatus } from '../types'

import { isDone } from './rows'
import { isRecord, oneLine } from './util'

// The plan an orchestrator posts with the plan tool: a title, the phase the
// flow is in, and the tasks it means to hand out. Workers never post one.

export const PHASES: Phase[] = ['plan', 'design', 'tasks', 'review', 'done']
export const TASK_STATUSES: TaskStatus[] = ['planned', 'running', 'done', 'failed', 'skipped']

// One task as a call may send it: only id is needed, the rest updates in place
export type TaskReport = {
  id: string
  title?: string
  tier?: string
  dependsOn?: string[]
  status?: TaskStatus
}

export type PlanReport = {
  title?: string
  phase?: Phase
  tasks: TaskReport[]
}

export const MAX_TASKS = 50

export const isPhase = (v: unknown): v is Phase => typeof v === 'string' && PHASES.some(p => p === v)

export const isTaskStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && TASK_STATUSES.some(s => s === v)

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const text = oneLine(v, max)
  return text || undefined
}

const readTask = (v: unknown): TaskReport | undefined => {
  if (!isRecord(v)) return undefined
  const id = clean(v.id, 40)
  if (!id) return undefined
  const task: TaskReport = { id }
  const title = clean(v.title, 120)
  if (title) task.title = title
  const tier = clean(v.tier, 24)
  if (tier) task.tier = tier
  if (Array.isArray(v.dependsOn)) {
    task.dependsOn = v.dependsOn.map(d => clean(d, 40)).filter((d): d is string => d !== undefined && d !== id)
  }
  if (isTaskStatus(v.status)) task.status = v.status
  return task
}

// What a plan call may carry; anything else on the call, and any malformed
// task, is ignored
export const readPlanReport = (input: Record<string, unknown>): PlanReport => {
  const report: PlanReport = { tasks: [] }
  const title = clean(input.title, 120)
  if (title) report.title = title
  if (isPhase(input.phase)) report.phase = input.phase
  if (Array.isArray(input.tasks)) {
    input.tasks.forEach(item => {
      const task = readTask(item)
      if (task) report.tasks.push(task)
    })
  }
  return report
}

// Merges a report into the plan. A new title starts a new plan; otherwise
// fields left out keep their value and tasks are matched by id, so a task can
// be renamed without losing its place or status.
export const withPlan = (plan: PlanRow, report: PlanReport, now: number): PlanRow => {
  const fresh = report.title !== undefined && plan.title !== undefined && report.title !== plan.title
  const base: PlanRow = fresh ? { tasks: [] } : plan
  const tasks = base.tasks.slice()
  report.tasks.forEach(item => {
    const at = tasks.map(t => t.id).indexOf(item.id)
    const old = at >= 0 ? tasks[at] : undefined
    const merged: PlanTask = {
      id: item.id,
      title: item.title || (old ? old.title : item.id),
      tier: item.tier !== undefined ? item.tier : old ? old.tier : undefined,
      dependsOn: item.dependsOn !== undefined ? item.dependsOn : old ? old.dependsOn : [],
      status: item.status || (old ? old.status : 'planned'),
    }
    if (at >= 0) tasks[at] = merged
    else if (tasks.length < MAX_TASKS) tasks.push(merged)
  })
  return {
    title: report.title !== undefined ? report.title : base.title,
    phase: report.phase !== undefined ? report.phase : base.phase,
    tasks,
    updatedAt: now,
  }
}

// The acknowledgement the orchestrator gets back, with task status as the
// runs have it
export const planAck = (plan: PlanRow, rows: AgentRow[]): string => {
  const done = plan.tasks.filter(t => taskStatus(t, rows) === 'done').length
  return (
    'ok: ' +
    (plan.title ? '"' + plan.title + '", ' : '') +
    'phase ' + (plan.phase || 'none') + ', ' +
    plan.tasks.length + (plan.tasks.length === 1 ? ' task' : ' tasks') +
    ' (' + done + ' done)'
  )
}

// A spawn names the task it carries out with a [task:<id>] marker in its
// description or prompt. Matching on the id, not the title, survives a rename.
const TASK_MARK = /\[task:\s*([^\]\s]+)\s*\]/i

export const taskIdOf = (description: string, prompt: string): string | undefined => {
  const found = TASK_MARK.exec(description) || TASK_MARK.exec(prompt)
  const id = found ? found[1] : undefined
  return id ? id.slice(0, 40) : undefined
}

// The description with its marker taken out, for the agent's name
export const withoutTaskMark = (text: string): string => text.replace(TASK_MARK, '').replace(/\s+/g, ' ').trim()

// Where a task stands. A verdict the orchestrator posted (done, failed,
// skipped) is final; otherwise the latest run carrying the task's id decides,
// and a task with no run keeps what was posted.
export const taskStatus = (task: PlanTask, rows: AgentRow[]): TaskStatus => {
  if (task.status === 'done' || task.status === 'failed' || task.status === 'skipped') return task.status
  const runsOf = rows.filter(row => row.taskId === task.id)
  if (runsOf.length === 0) return task.status
  const latest = runsOf.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
  if (latest.status === 'running') return 'running'
  return isDone(latest.status) ? 'done' : 'failed'
}

// The latest run of a task, for its progress and the link to its row
export const runOf = (task: PlanTask, rows: AgentRow[]): AgentRow | undefined => {
  const runsOf = rows.filter(row => row.taskId === task.id)
  return runsOf.length === 0 ? undefined : runsOf.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
}

// One stop on the flow bar, and whether the flow is past it, on it or not
// there yet
export type FlowStep = { label: string; state: 'past' | 'current' | 'future' }

export const flowSteps = (plan: PlanRow, rows: AgentRow[]): FlowStep[] => {
  const at = plan.phase ? PHASES.indexOf(plan.phase) : -1
  const done = plan.tasks.filter(t => taskStatus(t, rows) === 'done').length
  return PHASES.map((phase, i) => ({
    label:
      phase === 'tasks' && plan.tasks.length > 0
        ? 'Tasks ' + done + '/' + plan.tasks.length
        : phase.charAt(0).toUpperCase() + phase.slice(1),
    state: i < at || (phase === 'done' && i === at) ? 'past' : i === at ? 'current' : 'future',
  }))
}

// The mark and colour a task's status is drawn with
export const TASK_MARKS: { [s in TaskStatus]: { mark: string; color?: string } } = {
  planned: { mark: '○' },
  running: { mark: '●', color: 'yellow' },
  done: { mark: '✓', color: 'green' },
  failed: { mark: '✗', color: 'red' },
  skipped: { mark: '–' },
}

// Dependencies of a task that have not finished, so the line can say what it
// waits on
export const waitingOn = (task: PlanTask, plan: PlanRow, rows: AgentRow[]): string[] =>
  task.dependsOn.filter(id => {
    const dep = plan.tasks.filter(t => t.id === id)[0]
    if (!dep) return false
    const s = taskStatus(dep, rows)
    return s !== 'done' && s !== 'skipped'
  })

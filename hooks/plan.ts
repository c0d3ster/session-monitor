import type { Phase, PlanRow, PlanTask, TaskStatus } from '../types'

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

// The acknowledgement the orchestrator gets back
export const planAck = (plan: PlanRow): string => {
  const done = plan.tasks.filter(t => t.status === 'done').length
  return (
    'ok: ' +
    (plan.title ? '"' + plan.title + '", ' : '') +
    'phase ' + (plan.phase || 'none') + ', ' +
    plan.tasks.length + (plan.tasks.length === 1 ? ' task' : ' tasks') +
    ' (' + done + ' done)'
  )
}

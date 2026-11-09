---
name: orchestrate
description: Run a multi-task job through subagents and show the plan live in the session monitor pane. Use when work splits into several tasks handed to subagents, or when the user asks to orchestrate, plan and delegate, or see the plan in the monitor.
---

# Orchestrate with a live plan

The session monitor pane shows a plan you post: a flow bar (Plan, Design, Tasks n/m, Review, Done) and every task as planned, running, then done. You post it with the `mcp__session-monitor__plan` tool. Only the main session can post; a subagent's call is ignored.

## 1. Plan

Break the work into tasks, then post the whole plan in one call:

```json
{
  "title": "Add CSV export",
  "phase": "plan",
  "tasks": [
    { "id": "t1", "title": "Find where reports are built", "tier": "light" },
    { "id": "t2", "title": "Write the CSV builder", "tier": "medium", "dependsOn": ["t1"] },
    { "id": "t3", "title": "Tests for the builder", "tier": "medium", "dependsOn": ["t2"] }
  ]
}
```

- Give every task a short id (`t1`, `t2`, ...) and keep it for the rest of the run. Tasks are matched by id, so you can rename a task without losing it.
- `tier` is free text: the worker type or model the task is meant for.
- `dependsOn` lists ids that must finish first. The pane shows what a planned task still waits on.
- A call with a new `title` replaces the plan. Keep the same title for the whole run.

## 2. Move through the phases

Post `phase` when it changes: `design` if you settle an approach first, `tasks` once you start handing out work, `review` while you check results, `done` at the end. Send only what changed:

```json
{ "phase": "tasks" }
```

## 3. Spawn each task with its id

Put `[task:<id>]` in the subagent's description, for example `[task:t2] CSV builder`. The pane links that run to the task, so the task shows as running with the worker's progress, then done or failed when the run ends. The marker is left out of the agent's name in the pane.

Spawn tasks whose dependencies are done. Independent tasks can run in parallel.

## 4. Record your verdict

When you review a finished task, post the outcome. It overrides what the run reported:

- Accepted: `{ "tasks": [{ "id": "t2", "status": "done" }] }`
- Rejected and not retried: `"status": "failed"`
- Dropped from the plan: `"status": "skipped"`

To retry, spawn the task again with the same `[task:<id>]` marker. The newest run decides its status.

## 5. Close

When everything is reviewed, post `{ "phase": "done" }` and tell the user what was done.

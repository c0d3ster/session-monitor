# session-monitor

A Claude Code mod that adds a live monitor pane: this session's cost, context and cache, your usage limits, every other chat on the machine, and what the agents are doing (status, run time, tool calls, tokens, cost, with subagents nested under their parent). Requires Claude Code v2.1.287 or later (terminal or Desktop app Code tab).

It was called `agent-monitor` until 0.2.0, when it grew past agents. Plugin names starting with `claude-` are reserved, so it is `session-monitor`.

## Commands

| Command | Opens |
| --- | --- |
| `/session-monitor` | The full pane: this session, usage limits, cache, other chats and agents |
| `/agent-monitor` | The same pane showing agents only: no limits, cache gauge or other chats |
| `/agent-report` | The report on what the agents did |

It is one pane with two views, not two plugins. Press `m` in the pane (the `View:` button) to switch between full and agents-only. Agents-only hides My Plan, the cache gauge, Other chats, the idle and cache hotkeys and the `<o>` note, and keeps the context meter, subagents, Needs attention, filter, search and the report.

## Install

```
/plugin install session-monitor --marketplace c0d3ster/session-monitor
```

Originally written by Karl Adams.

## Try it

```bash
claude --plugin-dir ./session-monitor
```

Then run `/session-monitor`, `/agent-monitor` or `/agent-report`. Press `c` in the pane to clear finished agents, Esc to close it.

## Keep it

Copy the folder somewhere permanent (for example `~/mods/agent-monitor`) and add `--plugin-dir ~/mods/agent-monitor` to how you start Claude Code, or put it in a marketplace.

## How it works

- `agent.spawn` records each subagent when it starts
- `tool.call` counts calls per agent (`e.agentId`, or `main`)
- `turn.step` adds each model request's token counts to the agent that made it
- `turn.complete` marks agents done
- a 1-second timer syncs status from `$.agent.list()`, reads the context fill and cost from `$.session.usage()`, and redraws

## What the pane shows

- Header: running / done / failed counts, session cost, session tokens (in = uncached + cache writes, out, total, cached), a context-window meter with tokens used, window size and tokens left, and the prompt-cache figures (hit %, read, written, uncached) for the main session's latest request. These are real figures.
- Each running agent: run time, a progress bar with `~%`, tool calls, tokens (in, out, total; dashes until the first response is reported), and its latest tool call. Finished agents show two quiet lines.
- Press an agent's name (Tab to it, Enter) to open what it did: its task, its recent tool calls with timestamps, and the result it reported back.
- A new prompt starts a new run: agents that finished in earlier runs are cleared automatically. `c` clears them on demand.
- Progress is an estimate. Claude Code doesn't report how far through its work an agent is, so the bar is derived from tool calls and held under 95% until the agent finishes.

- Cache gauge: a hit-rate bar (green ≥70%, yellow ≥40%, red below) and a time-left bar for the prompt cache, counting down from the main session's last request. The lifetime (5 minutes or 1 hour) is read from the chat's transcript, from the newest request that wrote to the cache; with none to go on it assumes 5 minutes and shows `5m?`. When it hits zero the pane says the next request rebuilds the cache.
- Cache by chat: every chat the pane finds, with its context size, cache hit % and time left, soonest to lapse first. Each counts from its own last request and its own lifetime. A transcript over 4 MiB can't be read and is marked as such.
- Report: press `r` (or run `/agent-report`) for a markdown report of the current run and up to 6 earlier runs: each agent's task, tool-call counts, tokens, and result. Back (`b`), Copy (`y`), or Save (`s`) to `~/.claude/agent-reports/agent-report-<time>.md`.

- Cost: each subagent shows an estimated dollar cost and its model, calculated from list prices (Claude Code doesn't report per-agent cost). The header cost is the session's real figure.
- Needs attention: failed or stopped agents and agents whose tool calls returned errors are listed at the top with the latest error.
- Alerts (toasts, once each): an agent running over 3 minutes, an agent that fails, the same tool call made 5 times in a row, and the cache about to expire (60 s left).
- Branches: an agent with subagents shows their combined tokens and cost.
- Filter and search: `f` cycles all / running / failed; the search box matches agent names, types, tasks, results and tool calls.
- Learned progress: after two or more agents of a type finish, the progress bar uses their average call count instead of the default curve.
- Saved history: each finished run is written to `~/.claude/agent-reports/` (`run-<time>.md`, and `history.json`, which the next session loads so the report keeps earlier runs). The report also compares runs side by side, and exports as JSON (`j`) or CSV (`v`).
- If model responses arrive without token counts, the pane says so instead of showing dashes silently.

## Other chats

Below this session, the pane lists every other chat it finds (from `~/.claude/sessions/`): working chats first, then idle ones (shown by default; the idle chats button or `i` hides them). Each row reads `<o> ● name`, then its figures and cost. Press the name to open that chat's details.

- Status dot: working, idle, or handed off. A chat that handed its work to a background job (its session file has a `parkedJobId`) is shown as idle and labelled `handed off to <job name>`, not as working.
- Working detection: a chat counts as working when its session file says busy or its transcript changed in the last 45 seconds. A background job whose `state.json` has a `needs` message (for example `send a prompt to start`) counts as idle and reads `waiting: <what it needs>`. Background jobs always report idle in their session file, so the transcript is what shows them working.
- Details block: folder, handoff, kind, started, latest prompt, idle time, latest activity, tool calls, agents, tokens, context and cache, and a problem line if the transcript can't be read. Only one chat is open at a time.
- Cache by chat: context size, cache hit % and time left per chat, soonest to lapse first. Transcripts over 4 MiB are read from the tail (`scripts/big-transcript.cjs`).
- Usage limits: the 5 hour, weekly and spend limits with an estimated cost, and a toast when one passes a threshold.

### Which chats get `<o>` (the eyeball)

`<o>` raises the window that is showing the chat. It appears only when the pane has found something to raise. The pane checks every chat in one batch every 30 seconds (`scripts/focus-window.cjs --probe`), so it shows up a few seconds after a chat appears.

| Chat | `<o>` | What pressing it does |
| --- | --- | --- |
| Interactive chat, window found | yes | Raises the host window. Windows Terminal and Cursor share one window between chats, so those raise the window, not the tab. Terminal.app and iTerm2 on macOS also select the tab. |
| Interactive chat, no window found | no | Nothing to raise. |
| Background job with a `claude attach <id>` or `claude agents` terminal showing it | yes | Raises that terminal. |
| Background job nothing is showing | no | If a press finds nothing at that moment, it copies `claude attach <id>` instead and says so in a toast. |
| Spare worker | no | Spare workers have no terminal. |

A missing `<o>` means no window was found. It does not mean the chat is dead. Two interactive chats with no `<o>` turned out to be the live front ends of Cursor terminal tabs, which share one window.

### Which chats get Stop job

`■ Stop job` is on the `kind` row of an expanded chat, right-aligned, so a long prompt further down can't be mistaken for part of it.

| Chat | Stop job |
| --- | --- |
| Background job | yes |
| Interactive chat | no, on purpose |
| Spare worker | no |
| This session's own job | no |

- Two presses: the first changes the button to `■ Press again to stop`, the second runs `claude stop <job id>`. Opening another chat cancels a pending first press.
- It keeps the conversation: `claude attach <job id>` brings the job back. It never uses `claude rm`, which deletes the session.
- Interactive chats get no button because the only way to end one from outside is a hard process kill. That skips Claude Code's terminal cleanup and leaves the terminal tab printing escape characters (seen twice on Windows with Cursor and Git Bash terminals). End one with `/exit` in its own tab, or close the tab.

## Terminal window support

The focus helper (`scripts/focus-window.cjs`) runs on Windows (through `focus-window.ps1`), macOS (System Events) and Linux (`xdotool` or `wmctrl`, X11 only). Only the Windows path has been run. When a host has several windows, it picks the one whose title names the chat's folder.

## Files

- `hooks/register.ts`: the hooks and the pane
- `hooks/rows.ts`, `report.ts`, `transcripts.ts`, `format.ts`, `util.ts`, `constants.ts`, `limits.ts`, `state.ts`: agent rows and cost, the report, transcript readers, formatting and shared state. The state atoms stay in `register.ts`, because the engine needs each atom defined in the file that reads and writes it.
- `scripts/`: focus helper, big-transcript reader, window cost reader
- `tests/session-monitor.test.ts`: pane tests
- `CHANGELOG.md`: what changed in each version

Check it with `claude plugin validate .` and `claude plugin test .`.

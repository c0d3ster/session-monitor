# Changelog

All notable changes to agent-monitor. Newest first. Versions follow `.claude-plugin/plugin.json`.

Bump the version in `plugin.json`, add an entry here, then `claude plugin update agent-monitor@my-mods`.

## Unreleased

Changed

- Idle chats are listed by default in the full view; the `Idle chats` button and `i` hide them.

Fixed

- A background job whose `state.json` has a `needs` message (for example `send a prompt to start`) is no longer counted as working. It sits with the idle chats and reads `waiting: <what it needs>`.
- A working chat with nothing to count says `no requests in the transcript yet` (or `no transcript yet`) instead of `no figures yet`.
- A working chat's row has its cache line again (`ctx 61k · 93% hit · ~52m of 1h`, coloured by time left). 0.1.38 removed it from the row as well as the expanded block; only the expanded block was meant to lose it, as a duplicate. The expanded block still leaves it out.

## 0.2.0 - 2026-10-11

Changed

- Renamed from `agent-monitor` to `session-monitor`: the pane now covers the session, other chats, usage limits and cache as well as agents. The name `claude-monitor` is refused, since third-party plugin names cannot start with `claude-`. Install it with `claude plugin install session-monitor@my-mods` (the old `agent-monitor@my-mods` was uninstalled).
- Saved view settings start fresh once: the state keys moved from `agent-monitor.*` to `session-monitor.*`. Saved run history in `~/.claude/agent-reports/` is untouched and still loads.

Added

- `/session-monitor` opens the full pane. `/agent-monitor` stays and now opens the same pane showing agents only (no My Plan, cache gauge, Other chats, idle and cache hotkeys, or `<o>` note). `/agent-report` is unchanged.
- A `View: full` / `View: agents` button (`m`) in the footer switches between the two views without leaving the pane.
- Tests for both commands and the View button (18 in all).

Notes

- The folder is still `my-mods/agent-monitor`: another process held it open and it could not be renamed. The marketplace points at that path. Rename it to `session-monitor` and change `source` in `my-mods/.claude-plugin/marketplace.json` once nothing has it open.

## 0.1.40 - 2026-10-10

Changed

- `■ Stop job` moved from the `started` row to the `kind` row of an expanded background job, still right-aligned. A long prompt below no longer makes it look like part of the prompt.
- Footer hint with no agents running is two wrapping lines, "press a subagent name to see what it did" and "press a chat name under Other chats for its details". The one-line version was clipped and cut off the second "d" of "did".

Added

- README now documents which chats get `<o>` and which get Stop job, and the other chat features.

Notes

- Correction to 0.1.37: Two chats, and later a third, did not have dead terminals. A missing `<o>` only means no window was found; Cursor and Windows Terminal share one window between tabs. Hard-killing two of them filled their terminal tabs with escape characters both times. Stop job therefore stays on background jobs only.

## 0.1.39 - 2026-10-09

Added

- `■ Stop job` at the right edge of the `started` row in an expanded background job (in line with the costs). The first press changes it to `■ Press again to stop`; the second runs `claude stop <job id>`, which keeps the conversation (`claude attach <job id>` brings it back). It never uses `claude rm`, which deletes the session. Spare workers and this chat's own job have no button, and opening another chat cancels a pending first press. Not run against a real job yet: the tests cannot seed other chats.

## 0.1.38 - 2026-10-09

Added

- The expanded chat block shows the latest prompt typed in that chat, right after `started` (a slash command shows as the command and its arguments, tags and reminders are dropped, 300 characters at most). It comes from the chat's transcript, for big transcripts too (`scripts/big-transcript.cjs` reads it from the tail). It is displayed only, never logged or saved.

Changed

- `<o>` is found for all chats in one batch: `focus-window.cjs --probe` reads the process table once (a single PowerShell call on Windows) and answers for every chat, every 30 seconds, so the eyes appear together instead of a few at a time. The last answer stays until the next is back. On this machine the call for 11 chats takes about 4 to 5 seconds, mostly PowerShell listing the processes.
- A working chat no longer has a cache line under its facts, and its expanded block has no cache row.
- The expanded chat block is indented to the colour dot, and the subagent list is indented two cells so its arrow lines up with it.
- Footer: the `<o>` note no longer mentions background jobs, and the second note reads "press a subagent name to see what it did, or a chat name under Other chats for its details".

## 0.1.37 - 2026-10-09

Changed

- `<o>` shows only on chats whose window can be found. The pane runs the focus helper in dry-run mode for each chat (three at a time, each chat once a minute) and keeps the answer. A chat whose terminal was closed (the orphaned Git Bash shells) and a background job nothing is showing get no `<o>`, so it no longer leads to "no window found". Checked against the live chats: two chats with expired caches and no terminal get none; the rest do. A chat shows its `<o>` a few seconds after it first appears, once its first probe is back.
- The expanded block no longer repeats what the row shows. For a working chat it drops the time working, tokens and context; for every chat it drops the cost. The `↗ Focus terminal` button in it is gone, since `<o>` does that.

## 0.1.36 - 2026-10-09

Changed

- `<o>` on a background job raises the terminal that is showing it. A background job runs in a hidden pty host with no window; what you see in an editor terminal is a separate `claude attach <job id>` or `claude agents` client. `scripts/focus-window.cjs --viewer-of <job id>` finds that client (an `attach` for this job first, else a `claude agents` dashboard, which lists every job), walks up to its window, and picks the window naming the job's folder when the host has several (checked on Windows: a migration job resolved to its Cursor window).
- Only when nothing is showing the job does `<o>` fall back to copying `claude attach <job id>`, and the toast says so.

Notes

- A `claude agents` dashboard does not say which job it has open, so for a job with no `attach` client of its own the folder match uses the job's folder and can miss; the toast then says none of the host's windows names the folder.

## 0.1.35 - 2026-10-09

Changed

- A chat row reads `<o> ● name`: the coloured status dot replaces the `▸` / `▾` arrow before the name, so every row has its dot in the same place. `<o>` is the first column. Pressing the name still opens and closes the chat's details; the open block under the row is the only sign of it.

## 0.1.34 - 2026-10-09

Changed

- Every chat row keeps its coloured status dot again, and `<o>` is its own column right after it, so the dot is in the same place on every row. The first two columns are five cells wide for all chats.
- A background job (no terminal) gets `<o>` too: pressing it copies `claude attach <job id>` to the clipboard and says so in a toast. A spare worker has neither action and leaves that cell blank.
- The footer note for `<o>` mentions the attach command and wraps in a narrow pane.

## 0.1.33 - 2026-10-09

Added

- `<o>` at the start of a chat row (busy and idle) raises that chat's terminal window, so the focus action no longer needs the chat expanded. A chat with no terminal (a background job, a spare worker) keeps its status dot, padded to the same three cells so the names line up. The button cannot be coloured, so the dot's status colour shows only on the chats without one; the cache and cost colours are unchanged.

Fixed

- A chat counts as working when its transcript changed in the last 45 seconds, not only when its session file says busy. A background job's session file keeps saying idle while it works (`Cover letter location` showed as idle during a live conversation). A chat that handed its work to a background job still never counts as working.

Changed

- Footer: two italic notes (what `<o>` does, then the press-a-name hint) above the hotkeys, which are now the last line.

## 0.1.32 - 2026-10-09

Added

- A chat that handed its work to a background job (its session file has a `parkedJobId`) no longer shows as working. It keeps the "busy" status it had when it handed off, so it used to sit in the working list for as long as the job ran. It is now an idle chat labelled `handed off to <job name>`, and its expanded block has a `handoff` row naming the job.

## 0.1.31 - 2026-10-08

Fixed

- Focus terminal raises the right Cursor window. Cursor keeps one window per workspace under a single process, and the helper used to take the first one for every chat. It now lists every window the host owns and picks the one whose title names a folder of the chat's directory, deepest first (`file - folder - Cursor`). On Windows it matched each of three chats to its own workspace window. If none of the windows names the folder, it raises the first and the toast says so. The macOS (System Events) and Linux (xdotool, wmctrl) paths do the same match but have not been run on those systems.

Changed

- `↗ Focus terminal` sits right under `kind` in an expanded chat.
- In an expanded chat the labels are a column of their own, so a value that wraps (`latest`, `folder`) lines up under where its first line starts instead of under the label.

## 0.1.30 - 2026-10-08

Changed

- A busy chat's cache figures (ctx, hit rate, time left) are on their own line under its other facts, so they always start in the same place.

## 0.1.29 - 2026-10-08

Changed

- The footer hint (`press a name to see what it did`, or the progress-estimate note while agents run) is in italics on its own line under the hotkeys.

## 0.1.28 - 2026-10-08

Fixed

- A busy chat's time active sits beside its name again; only the cost is right-aligned.

## 0.1.27 - 2026-10-08

Added

- `↗ Focus terminal` in an expanded chat raises the window that hosts it. `scripts/focus-window.cjs` (run with `node`) does it on Windows (through `focus-window.ps1`), macOS and Linux. It walks up from the chat's process to the first ancestor that owns a window, then raises it. Terminal.app and iTerm2 on macOS also select the tab by its tty. Windows Terminal and Cursor share one window between chats, so those raise the window only.
- It says why when it cannot: background and spare chats have no terminal (no button), a terminal that was closed leaves the chat with no traceable window, and on Linux it needs `xdotool` or `wmctrl` and X11 (Wayland does not allow it).

Changed

- A busy chat's cost is right-aligned on its title line, in a column, like the idle rows. It was part of the facts line.

Notes

- Checked on Windows only (dry run against the live chats: the Cursor chats resolve to their window; chats whose terminal was closed, and background chats, report no window). The macOS and Linux paths pass a syntax check but have not been run on those systems.

## 0.1.26 - 2026-10-08

Added

- Other chats, busy and idle, expand like subagents. Press a chat's name (`▸` / `▾`) to open what is known about it: folder, kind (spare, remote control), how long ago it started, how long it has been working or idle, its latest reply or action, tool calls (total, last tool, this turn), running agents, tokens, cost, and the cache breakdown (context, read, written, fresh, hit rate, time left). One chat is open at a time, apart from the open subagent. Nothing new is read from disk for this.
- A busy chat's cache figures now use the idle rows' colours: cyan while most of the lifetime is left, yellow when it runs low, red near the end or expired.

Fixed

- Opening or closing a subagent, using Back from the report, or clearing finished agents used to reset the other view settings (Idle chats, Cache info, filter, search). They are kept now.

Notes

- `last Bash` on a busy chat's line is the most recent tool that chat called.
- The expanded block was not covered by a test: the test harness has no other chats to seed.

## 0.1.25 - 2026-10-08

Changed

- Other chats header: the top right now shows `total ~$X` (every other chat, idle ones included), and `working ~$X` moved down to the counts line below it.
- Idle chats: the right edge is all cost. Each chat's own `~$X` is right-aligned, the idle total sits right-aligned on the summary line, and the cache time left (`~3m of 5m`, `cache expired`) moved in beside the hit rate. Costs are estimates; a chat with no readable cost shows a blank.

## 0.1.24 - 2026-10-08

Changed

- `tsc -p .` now reports no errors (it reported about 27 strict-index errors in `hooks/register.ts` and the test file). The fixes are narrowing and small helpers, no casts: `for...of` over the price and argument tables, `subsOf` and `usdOf` for the per-chat lookups, and typed inputs for the tests' `command.run` and `agent.spawn` calls. No change to what the pane shows.

## 0.1.23 - 2026-10-08

Added

- Chats over 4 MiB now show their exact lifetime tool-call count. `scripts/big-transcript.cjs` counts every tool call in the file in 8 MiB chunks that stop at a line break, and the pane passes back the count and byte offset from the last read, so a growing chat only costs what was appended. A file that shrinks is counted again from the start. Checked against 14 MB and 2 MB transcripts: same totals as a plain full-file count, from scratch and when resumed mid-file.
- The Other chats header adds `all ~$X` beside `working ~$X`: the estimated cost of every other chat, idle ones included. It is an estimate, and a chat with no readable cost figure adds nothing.

## 0.1.23 - 2026-10-08

Added

- Chats over 4 MiB now show their lifetime tool-call count, exact. `scripts/big-transcript.cjs` counts every tool call in the whole file in 8 MiB chunks that stop at a line break, and the pane passes back the count and byte offset from the last read, so a growing chat only costs what was appended. A file that shrinks is counted again from the start. Checked against 14 MB and 2 MB transcripts: same totals as a plain full-file count, from scratch and when resumed mid-file.
- The Other chats header adds `all ~$X` beside `working ~$X`: the estimated cost of every other chat, idle ones included. It is an estimate, and a chat with no readable cost figure adds nothing.

## 0.1.22 - 2026-10-08

Added

- Chats whose transcript is over 4 MiB now show their figures. `scripts/big-transcript.cjs`, run with `node` in a child process, reads only the last 1 MiB of each (growing a MiB at a time up to 4 MiB if the window has no model request or no typed prompt yet) and gives back the cache (context, hit %, time left, 5 minute or 1 hour), the latest reply, the last tool and the tool calls since the latest prompt.
- For those chats cost and token totals come from the `cost-state` line Claude Code keeps near the end of the transcript, so the cost is the real ledger figure, not a list-price estimate. A chat with no such line shows no total.
- The helper is asked again only when a big file's size has changed. All 9 big and small test files took about 120 ms in one call.

Notes

- Lifetime tool-call counts for big chats aren't available from the tail and stay hidden.
- If `node` can't be run or the file can't be read, the row says `unreadable: <reason>` instead of "transcript over 4 MiB".

## 0.1.21 - 2026-10-08

Changed

- Idle chats without usage data say why: `spare` (a pre-warmed background worker nobody has given work), `remote control, idle` (a helper waiting for a Remote Control prompt), `no transcript yet` (no file at all), or `no requests yet` (a file with no model request in it). Before, all of these read "no requests yet".

Fixed

- A chat that was readable and then grew past 4 MiB kept its old cache figures and showed them as "cache expired". They are cleared and the row says `transcript over 4 MiB`.

## 0.1.20 - 2026-10-08

Fixed

- A gap now shows between "My Plan" and "This session", and between the working chats and the idle line. The spacer before was an empty string, which a terminal pane draws as no row at all; it is now a single blank row. A row is the smallest step a character-cell pane has, so the gap can't be less than one line.

## 0.1.19 - 2026-10-08

Changed

- "Idle chats" (`i`) lists every idle chat, since each is still a running process: live caches first (soonest to lapse on top), then lapsed ones (`cache expired`), then chats with no readable request (`no requests yet`, `transcript over 4 MiB`). It no longer hides the lapsed ones behind a count.
- Names in that list are padded so ctx and hit rate start in the same column on every row, and the time left stays at the right edge. The padding only happens when the window is wide enough for the name, both figures and the time left on one line; otherwise rows go back to their natural widths.

## 0.1.18 - 2026-10-08

Changed

- "Other chats" and "Cache by chat" are one section. A working chat's last line now carries its cache (`ctx 61k · 93% hit · ~52m of 1h`).
- Idle chats collapse to one line: `6 idle · 4 with a live cache · next lapse notes ~3m  (i to list)`. The new "Idle chats" button (`i`) lists the ones whose cache is still live; chats with a lapsed cache or no requests yet stay in the count.
- Idle chat rows keep the context and hit rate on the left and put the time left at the right edge (`~52m of 1h`).
- Removed the "your other chats are listed…" hint from the empty Agents state.
- The `h` button is now "Cache info" and hides the cache figures everywhere in the section instead of hiding a whole section.

## 0.1.17 - 2026-10-08

Changed

- Pane order is now: My Plan, This session, Needs attention, this chat's agents, then Other chats and Cache by chat. Problems sit right under the session block instead of below the chat list, and the chat's own agents come before everyone else's.
- The cache line carries its figures (`read 91k · written 8k · new 5k`) on the same row as the hit bar, one row shorter than before. "uncached" is now "new".

## 0.1.16 - 2026-10-08

Changed

- The 5-hour and weekly costs under "My Plan" are right-aligned on their rows, like the session and working costs, instead of running on after the reset time.

## 0.1.15 - 2026-10-08

Added

- Estimated cost of each usage window under "My Plan": the 5-hour and weekly rows now read `23% · ~$54 · resets in 1h42m (6:30am)`. The cost is what the replies inside that window would have cost at API list prices. Compare it to what you pay for the plan.
- `scripts/window-cost.cjs`, run in a child process (`node`) once a minute. It streams every transcript on this machine line by line, so files over the 4 MiB read limit count too, and counts each reply once even when a resumed session repeats it. A full scan of about 150 MB takes under 2 seconds.

Notes

- Only Claude Code on this machine is counted. The plan's limits cover your whole account, so use on claude.ai or other devices is not in the figure.
- It uses the same list prices as the other cost figures, with cache writes at 1.25x. One-hour cache writes really cost 2x, so the figure can run a little low.
- If `node` can't be run, "My Plan" says `cost n/a` with the reason, and the bars still work.

## 0.1.14 - 2026-10-08

Changed

- The estimated cost of the other chats is right-aligned on the "Other chats" heading and reads "working ~$2.11", matching "session $X" above. The chat/agent/idle counts moved to a dim line under it.

## 0.1.13 - 2026-10-08

Fixed

- 0.1.12 asked `$.agent.list()` from inside the `tool.call` hook, which errors there, so tool calls stopped being tracked. The check now uses the ids the once-a-second sync has already seen plus the rows spawned agents already have. Same result: no row for Claude Code's own helper calls (`a4809038`, "No tools needed for suggestion"), and agents that were spawned are tracked as before. Don't use 0.1.12.

## 0.1.12 - 2026-10-08

Fixed

- Stopped the phantom `a4809038` row at its source. Claude Code's own prompt-suggestion helper makes tool calls tagged with an agent id that was never spawned as an agent (its denied call reads "No tools needed for suggestion"). The mod now ignores a tool call from an agent id that `$.agent.list()` doesn't contain, so no row, no "1 error" under Needs attention, and nothing to clear. The 0.1.11 sweep stays as a backstop.

## 0.1.11 - 2026-10-08

Fixed

- A phantom agent row (for example `a4809038`, "Bash echo noop") that stayed "running" forever. A tool call tagged with an agent id the engine never spawned created a row nothing ever finished. Rows the engine's agent list doesn't know are now dropped once they are 20 seconds old, including ones already saved in the session's state, and come back only if that id makes another tool call.

## 0.1.10 - 2026-10-08

Changed

- The 5-hour and weekly limit bars moved to the very top under a "My Plan" heading, above "This session", since they describe the account and not the chat.
- The cost at the top right is labelled "session $X". It is this session's cost as /cost totals it, not a total across chats.

## 0.1.9 - 2026-10-08

Added

- Usage limit bars under the context bar: the 5-hour window and the weekly window, each with percent used and "resets in 1h42m (6:30am)". Green below 70%, yellow from 70%, red from 90%. A spend limit shows too when there is one.
- A toast the first time a window passes 90%, once per window.
- Figures are what the last API response reported (`$.session.usage().rateLimits`). Nothing shows off a subscription or before the first response. Claude Code gives only percent used and reset time, not a token quota.

## 0.1.8 - 2026-10-08

Changed

- "Conversations" is now "Other chats" and "Cache by chat" lists the other chats too. This chat is covered by the "This session" block and its own Agents list, so it appears once.
- This chat's subagents are no longer counted a second time in the "N agents" figure.
- Removed the "(this chat)" tags, which are no longer needed.

## 0.1.7 - 2026-10-08

Changed

- The top of the pane is headed "This session · <session title>", using the same name the "Cache by chat" rows use, so the context, cache and expires bars read as this chat's own.

## 0.1.6 - 2026-10-08

Changed

- The footer (Report, Clear finished, Show, Cache by chat) is pinned to the bottom of the pane instead of sitting right under the last line of content. The content fills the room the dock gives and the footer follows it.

## 0.1.5 - 2026-10-07

Changed

- "Cache by chat" is back to the 0.1.3 look: one text line per chat, no bars, no kind tag, plain heading.

## 0.1.4 - 2026-10-07

Added

- Busy chats get an estimated progress bar for the current turn, from the tool calls made since the latest prompt (the same curve a subagent uses). It's a guess: Claude Code doesn't report progress. Active chats only.
- `h` / the "Cache by chat" footer button hides and shows the cache section.

Notes

- The chat list is one row per live Claude process in `~/.claude/sessions`, background jobs included, so it can be longer than the number of terminals you have open. Capped at 12 rows.
- 0.1.4 also put two bars on each cache row. Reverted in 0.1.5.

## 0.1.3 - 2026-10-07

Added

- "Cache by chat" section: every chat the pane finds, with its context size, cache hit % and time left on its cache entry, soonest to lapse first. Each chat counts from its own last request, read from its own transcript.
- Real cache lifetime per chat. The newest request that wrote to the cache says whether it used the 1 hour or 5 minute entry (`cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`). Shown as `of 1h` or `of 5m`; a trailing `?` means no recent write said and 5 minutes is assumed.
- Idle chats are read too (every 30 seconds, and only when the transcript's size changed), so their expiry shows before they lapse.

Changed

- The header cache countdown and the "cache about to expire" toast use this chat's detected lifetime instead of a fixed 5 minutes, and the header now says `of 1h` or `of 5m`.
- Busy chats are re-read only when their transcript changed.

Known limits

- A transcript over 4 MiB can't be read by `$.fs.read`, so that chat shows "transcript over 4 MiB, cannot read" instead of cache figures.
- Context shows tokens used, not a percentage, for other chats: their window size isn't recorded in the transcript.

## 0.1.2 - 2026-10-07

Added

- Tokens and estimated cost for each busy chat in the Conversations section, summed from the `usage` blocks in its transcript. The last usage seen per message id is counted, since a streaming reply can be written more than once.
- Total estimated cost of all working chats next to the working count.
- A fallback line for chats with no job file: the first line of the latest reply, else the latest tool call.

## 0.1.1 - 2026-10-07

Added

- Conversations section listing every session the agents panel knows about (read from `~/.claude/sessions` and `~/.claude/jobs/<id>/state.json`), with a working count: chats, agents, idle.
- Per busy chat: name, kind, time since last status change, job detail, tool-call count, last tool, and number of running subagents (from the chat's `subagents` folder).
- Scan runs every 2 seconds on its own timer so a slow read can't stall the main one.

Changed

- Empty state now reads "No subagents in this chat. Your other chats are listed under Conversations."

## 0.1.0 - 2026-10-07

Initial version.

- `/agent-monitor` pane: per-agent status, run time, estimated progress, tool calls, tokens and estimated cost, with subagents nested under their parent.
- Session header: cost, tokens, context window used and remaining, prompt-cache hit bar and time-left bar.
- Cache countdown assumes a 5 minute lifetime.
- Needs attention panel, toasts for long-running agents, repeated calls and cache about to expire.
- `/agent-report`: per-run tables, run comparison, copy, save as markdown, JSON or CSV. Runs are saved to `~/.claude/agent-reports/`.
- Filter (`f`), search, learned progress curves, branch totals.

# agent-monitor: review request

A Claude Code mod (plugin of JS/TS event handlers) that adds an `/agent-monitor` pane showing what agents are doing, plus `/agent-report`. Built against https://code.claude.com/docs/en/plugins/mods/overview. Needs Claude Code v2.1.287 or later.

## Set up (2 minutes)

1. Unzip `agent-monitor.zip`.
2. Try it for one session:
   ```bash
   claude --plugin-dir ./agent-monitor
   ```
3. Run `/agent-monitor`. Esc closes the pane.
4. To load it in every session, install it from a local marketplace:
   ```bash
   mkdir -p ~/.claude/my-mods/.claude-plugin
   cp -R ./agent-monitor ~/.claude/my-mods/agent-monitor
   cat > ~/.claude/my-mods/.claude-plugin/marketplace.json <<'JSON'
   { "name": "my-mods", "owner": { "name": "Me" }, "description": "Local mods",
     "plugins": [ { "name": "agent-monitor", "source": "./agent-monitor", "description": "Agent monitor pane" } ] }
   JSON
   claude plugin marketplace add ~/.claude/my-mods
   claude plugin install agent-monitor@my-mods
   ```

## A test prompt

> Run three subagents in parallel: one to list the main folders of this project, one to find every TODO comment, one to summarise the README. Then combine their findings.

## What it shows

- Per agent: status, run time, estimated progress bar, tool calls, tokens (in, out, total), estimated cost and model.
- Session: cost, tokens, context window used and remaining, prompt-cache hit bar and a time-left bar.
- Needs attention panel for failed agents and tool errors; toasts for long-running agents, repeated calls and cache about to expire.
- Press an agent's name to see its task, actions and result. `f` filters, search box finds text.
- Report (`r` or `/agent-report`): per-run tables, run comparison, copy, save as markdown, JSON or CSV. Runs are saved to `~/.claude/agent-reports/`.

## Known limits (please check these)

- Progress is an estimate from tool calls; Claude Code reports none.
- Per-agent cost uses list prices I entered (`RATES` in `hooks/register.ts`); they may be out of date.
- The cache lifetime (5 minutes or 1 hour) is read from each chat's transcript; with no recent cache write to go on, 5 minutes is assumed and shown as `5m?`.
- Per-agent tokens come from the `turn.step` hook and passed tests only with stubs. The first thing to confirm is that tokens fill in during a real run.

## Feedback wanted

- Does it work on your setup, and do tokens and model names fill in?
- Is the pane readable at your terminal width?
- Anything missing or noisy? Are the alerts useful or annoying?
- Any problems with the code in `hooks/register.ts`?

Check the code with `claude plugin validate .` and `claude plugin test .` from inside the folder.

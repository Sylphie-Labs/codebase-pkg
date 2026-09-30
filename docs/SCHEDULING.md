# Scheduling the graph refresh

`/refresh-pkg-graph` (see `template/.claude/skills/refresh-pkg-graph/SKILL.md`) is cheap enough to
run unattended on a schedule: it syncs the graph mechanically (git-diff + contentHash) and then
re-classifies/re-infers ONLY the nodes that changed, instead of re-enriching the whole graph. Two
ways to schedule it:

## Windows: `codebase-pkg schedule-refresh`

```bash
codebase-pkg schedule-refresh                    # daily at 03:00 (default)
codebase-pkg schedule-refresh --time 22:30        # daily at a specific time (24-hour HH:MM)
codebase-pkg schedule-refresh --unregister        # remove the scheduled task
```

This registers a Windows Task Scheduler job named `codebase-pkg-refresh-<slug>` (the same
per-repo slug used for the Docker container/port derivation, so it stays stable and distinct per
repo) that runs daily, in this repo's directory:

```
claude -p "/refresh-pkg-graph" --model sonnet
```

`--time` must be 24-hour `HH:MM` (e.g. `03:00`, `22:30`); an invalid value is rejected before
anything is registered. Re-running `schedule-refresh` (with a new `--time`, or none) overwrites the
existing task rather than erroring, so changing the schedule is just running the command again.
`--unregister` removes the task; it's safe to run even if nothing was ever registered (schtasks
simply reports nothing to delete).

This subcommand shells out to `schtasks.exe` and only works on Windows. It always prints the exact
`schtasks` command it ran, so you can inspect or reproduce it manually (`schtasks /Query /TN
codebase-pkg-refresh-<slug>` to see the registered task).

Prefer `--path <dir>` (or `CODEBASE_PKG_ROOT`) the same way you would for `init`/`status`/etc. if
you're registering the schedule from outside the target repo directory.

## Manual / cross-platform alternative

On macOS/Linux, or anywhere `schtasks` isn't available, wire up the same command with whatever
scheduler you already have:

**cron** (`crontab -e`):

```cron
0 3 * * * cd /path/to/repo && claude -p "/refresh-pkg-graph" --model sonnet
```

**launchd** (macOS), **systemd timer**, or a CI scheduled pipeline all work the same way -- the
payload is always just:

```bash
cd <repo-dir> && claude -p "/refresh-pkg-graph" --model sonnet
```

Run it as often as your repo's edit cadence justifies. A repo with a handful of commits a day is
well served by once-nightly; a very active monorepo might run it hourly since the refresh is scoped
to only what changed since the last sync cursor, not the whole graph.

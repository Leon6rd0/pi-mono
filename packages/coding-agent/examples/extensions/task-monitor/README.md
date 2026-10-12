# Tasks, background jobs, and Monitor

This extension adds three model tools and a live task panel without replacing Pi's
Bash tool, provider, or compaction logic. It works with the fork's Pi 1.1.0 trial
binary through the normal extension loader; no binary rebuild is required.

## Behavior

- `tasks`: create/list/get/update/acknowledge logical tasks with dependencies.
  Default lists track active and unprocessed work, not all historical records.
- `background`: start/list/status/stop shell jobs. Starting returns a job ID,
  rather than keeping a tool call open until the command finishes.
- `monitor`: watch a **literal substring** in a running job's output. It runs
  locally, returns immediately, and sends bounded match events. No regex engine
  or periodic model polling is involved.
- `/tasks`: view the task/job registry and control jobs without asking the model.
  Commands execute even while the model is busy with another foreground tool.
- The TUI widget shows running jobs, monitor counts, and an optional live log tail.
  RPC receives notifications and can call the tools/commands, but has no TUI widget.

A background job is suspended Agent work, but not an open foreground tool call:
`prompt()` and `waitForIdle()` do not wait for it. Instructions also tell the model to finish its response instead of
running repeated status queries or `sleep` loops. These instructions do not forbid
a model from issuing an ordinary foreground Bash command; use `background` for
long work rather than expecting all existing Bash calls to become asynchronous.

## Load

```sh
pi --extension /absolute/path/to/task-monitor/index.ts
```

Or add that entry path to `extensions` in the agent-directory `settings.json` and
run `/reload`. Keep the directory's `index.ts` and `manager.ts` together. This is
an explicitly installed extension, not a new stock built-in tool.

The optional `<agent-dir>/task-monitor.json` config is user-level only:

```json
{
  "storageRoot": "/absolute/path/to/runtime-jobs",
  "allowedCwdRoots": ["/absolute/path/to/workspaces"],
  "notifyModel": true
}
```

All configured paths must be absolute. The default storage root is
`<agent-dir>/task-monitor`. On this machine, development logs and task records
must use a `/rivai` storage root. `background start` always requires an explicit
absolute `cwd`, even if Pi was started in the home directory.

`allowedCwdRoots` checks the canonical **starting directory**. It is not a
filesystem or network sandbox: a shell can still `cd` elsewhere or access any
resource allowed to the Pi OS user.

## Example workflow

Model tool arguments:

```json
{"action":"create","label":"Build the project"}
```

For `background`, using the task ID returned above:

```json
{
  "action": "start",
  "command": "make -j8",
  "cwd": "/absolute/path/to/project",
  "label": "Project build",
  "task_id": "task-<returned-uuid>"
}
```

For `monitor`, using the job ID returned by `background`:

```json
{
  "action": "start",
  "job_id": "job-<returned-uuid>",
  "pattern": "error:",
  "duration_seconds": 600,
  "max_events": 5
}
```

The tools return immediately. The conversation can continue while the build runs.
A job retains its actual exit status and becomes `review: awaiting`. Its linked
logical task becomes `awaiting_result`, with the process outcome in `resultStatus`.
Process termination is not logical task completion. Read and handle the result,
then call `tasks` with `action: acknowledge`, `id` (job or task), and a processing
`summary`. This archives both records; a successful task becomes `completed` and
unlocks its dependents. Failed/stopped results stay failed/stopped after review.
Acknowledgement does not delete logs, restart work, or undo effects.

Lists and the widget exclude acknowledged records by default. Use
`include_archived: true`, `/tasks history`, or `get` to inspect history. There is
no timer-based hiding. Manually marking an unlinked task `completed` is itself an
explicit processing decision and archives it. Linked ready results must use
acknowledgement instead. A task cannot start before its dependencies are completed.
Dependencies reference previously created tasks, so cycles cannot be introduced.

For a service or file watcher, start its normal foreground command or `tail -F`
as a background job. Do **not** add `&`, `nohup`, or deliberately detach its children.

User commands:

```text
/tasks list
/tasks history
/tasks logs job-<uuid>
/tasks ack job-<uuid> Read exit status and handled the result
/tasks stop job-<uuid>
/tasks stop all
/tasks unwatch monitor-<uuid>
/tasks notify off
/tasks notify on
```

`logs` selects the live tail in the TUI panel; `background status` returns a bounded
log tail to the model. Stopping a monitor does not stop its job. Stopping a job
requests backend cancellation and waits for termination confirmation, not natural
command completion. It does not undo already performed file or network actions.

## Notifications and cancellation

Real job completion and monitor matches are batched locally. With `notifyModel`
enabled, events can trigger a follow-up model turn in TUI/RPC. Those turns consume
normal model usage; the monitor itself does not use a model. `/tasks notify off`
keeps local notifications and records events for the next normal user turn.
Non-interactive print/JSON use the same next-user-turn behavior by default.

Escape aborts the current agent operation, not previously launched jobs. After an
aborted run, automatic event-driven model continuation stays paused until the next
real user input. Jobs remain visible and explicitly stoppable. Events are process
data, not new user requests or permission grants; stopped jobs never trigger a
completion follow-up. Failed jobs are not automatically relaunched by the runtime.

Quit, reload, and session replacement stop jobs owned by the old extension runtime
and dispose monitor/widget/notification timers. Conversation tree navigation does
not roll back tasks or real processes. A newly forked session gets its own registry.

## Limits and persistence

Defaults:

- 8 simultaneous jobs; 1000 task/job records per session.
- 10 MiB combined stdout/stderr per job. Exceeding the cap stops the job and marks
  it failed, rather than allowing unlimited disk growth.
- Job timeout: 24 hours by default, maximum 7 days.
- Monitor lifetime: 5 minutes by default, maximum 24 hours.
- 20 match events per monitor by default, maximum 100; minimum interval 1 second,
  default 3 seconds. Bursts inside the interval are suppressed, not replayed.
- At most 100 monitors per session runtime. Only output received after registration
  is watched; existing log text is available through `background status`.
- Status output is capped at 64 KiB; model-facing results are additionally truncated.
  List tools return compact summaries of the latest 50 active/unprocessed records
  by default, or historical records with `include_archived: true`.

Records and logs are private files under a session-keyed storage directory. They
survive compaction and normal restarts. Do not put inline credentials in commands:
command arguments and raw output are retained just like other tool/session data.
Log previews strip terminal controls; raw logs retain their original bytes.

A restored job previously recorded as running is shown as `unknown`, not assumed
completed or controllable. The extension never kills a PID recovered from disk.
Monitors are not resurrected automatically. This is not a cross-process job daemon;
do not use multiple Pi runtimes to operate the same session registry concurrently.
If a crash left a linked job unknown, confirm its real state externally before
repairing its stored task records; automatic takeover/reset is intentionally absent.
Unknown/unmanaged work cannot be acknowledged as complete. Ready backlog is
reintroduced on session start without triggering an automatic model turn.

## Execution and security

Local jobs use Pi's existing Bash execution backend, including shell settings,
command prefix, cancellation, timeout, and process-group cleanup. They do not
implicitly inherit a third-party extension's remote or sandboxed Bash override.
An SDK host must pass its shared backend explicitly:

```typescript
createTaskMonitorExtension({ storageRoot, operations: sharedBashOperations })
```

Custom backends must honor `signal` and `timeout`. Process-group cleanup is not
containment of programs that deliberately detach or escape their process group.
Permission extensions must cover `background` launch as well as `bash`; normal
`tool_call` hooks can block launch before any command runs. Tool annotations are
hints, not a security boundary. Do not enable local background execution alongside
a Bash-only sandbox and assume the sandbox covers it.

See Pi's [Extensions](../../../docs/extensions.md),
[Terminal UI](../../../docs/tui.md), and [Security](../../../docs/security.md).

## Validation

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/task-monitor-manager.test.ts test/suite/task-monitor.test.ts
```

Tests use the faux provider and local processes, never paid model APIs. Real TUI
smoke additionally checks the existing trial binary's extension loader, actual
Escape, log-match notification after abort, continued chat while a worker remains
alive, log viewing, resize, and explicit worker termination with a loopback mock API.

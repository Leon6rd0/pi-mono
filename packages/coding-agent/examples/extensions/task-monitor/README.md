# Tasks, background jobs, and Monitor

This extension adds three model tools and a live task panel without replacing Pi's
Bash tool, provider, or compaction logic. It uses the normal extension loader.
Bounded task continuation requires the fork's actionable `agent_before_settle`
boundary; validate the installed host separately from source tests. Updating
extension files alone is not proof that a running session has reloaded them.

## Behavior

- `tasks`: create/list/get/update/acknowledge logical tasks with dependencies,
  durable checkpoints, and explicitly enabled bounded continuation. `runtime`
  reports the loaded feature identity (`task-continuity-v2`), continuation limits and adapter readiness.
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
run `/reload`. Keep `index.ts`, `manager.ts`, `continuation.ts`, and `activity.ts`
together. This is an explicitly installed extension, not a new stock built-in tool.
If Workflow is installed, its matching activity/notification adapter must also be
present. An unavailable or ambiguous activity adapter blocks continuation rather
than guessing that no Workflow executor exists.

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

## Durable checkpoints and bounded continuation

Problem: `running` used to be only bookkeeping. After a successful build was
processed, a model could say “next phase later” and settle with no executor or
future event. A running label did not schedule that next phase; update summaries
were also discarded. Neither changing models nor refreshing that label fixes the
missing execution mechanism.

`tasks.update` now persists `summary`, `phase`, `next_action` and `blocked_reason`
without requiring a status change. `null` clears `next_action` or `blocked_reason`.
For example, after creating a root task:

```json
{
  "action": "update",
  "id": "task-<root-uuid>",
  "phase": "verify",
  "summary": "Implementation complete; validation not yet run",
  "next_action": { "key": "verify-1", "instruction": "Run the approved offline validation" },
  "blocked_reason": null
}
```

This is a checkpoint, **not opt-in**. Enable it with the user command
`/tasks continue task-<root-uuid> [count] [minutes]`, or `tasks` action `continue` with a fresh
UI confirmation. No UI means tool-based activation is refused. Scope, next step,
and limits are shown before confirmation. Mode ON, notify ON, model prose, task
labels and child results never substitute for task-specific opt-in.

Only one root can be armed. New confirmations default to **32 continuation/event
prompt reservations within 240 minutes (4 hours)**. Choose `max_continuations`
(1–128) and `duration_minutes` (1–1440, up to 24 hours), or the command's optional
count and minutes. Confirmation shows the selected limits; the widget/runtime
exposes the persisted expiry. Wall-clock time includes background waits. Expiry
stops future automatic prompts, not work already dispatched. An ordinary question
never resets a counter/deadline or re-arms a paused plan. Old ledger values are
preserved; installing new defaults does not extend existing consent.

Accounting is saved before dispatch. Two repeated unchanged progress comparisons
pause the plan; merely updating summary text does not reset this guard. These are
**not token, billing or total model-request caps**: ordinary tool turns within a
request cycle still occur, and Workflow retains its own separate budgets. Explicit
renewal starts a new finite allowance. Invalid activation parameters do not write
a receipt; an interrupted/failed activation cannot leave a usable partial grant.

At a successful settle boundary, a ready plan requests its next scoped step.
Live executors and unprocessed results suppress boundary continuation: wait for
real completion events, read/process results, acknowledge, then continue. Owned
completion prompts share the allowance and are deduplicated per executor, even
across overlapping batches. Log matches cannot consume plan-continuation prompts.
Other extensions' boundary entries and pending user messages retain priority.

`parent_id` links subordinate logical tasks. New tasks/jobs automatically attach
to the active root unless a task's parent is explicitly supplied. Nested leaves
are supported; one linked job attempt owns its leaf, which cannot become a parent
or be reused for another attempt. Parent completion requires processed descendants;
active Workflow activity also blocks completion. Workflow IDs observed during the
armed interval are recorded through a trusted metadata adapter, not inferred from
child output. The session-wide Workflow activity gate is deliberately conservative.

Ordinary user input has priority, but does not revoke an existing grant: answer it
before any next task step. Input still invalidates an open activation dialog, even
before the first grant. The assistant must call `tasks pause` **before acting on a
natural-language stop, changed scope, unrelated new work, or new permission request**.
This is model-facing guidance, not a natural-language intent classifier. Use the
deterministic `/tasks pause` or Escape for an immediate control action. Unrelated
work must not be attached to the old plan simply because its receipt is still live.

`/tasks pause`, branch changes, Escape/error, explicit job stop and reload revoke
future scheduling. They do not undo work or retract an already dispatched request.
Stopped/unknown work is not recoverable as an ordinary failed step. Stop blocks the
current grant even after acknowledgement; a later explicit new grant can authorize
different work, never restart the old executor. Unknown task records still require
external inspection rather than a guessed outcome. Reload retains checkpoint and
counter evidence but requires fresh opt-in; notification toggles do not re-arm it.

A failed result waits for processing without permanently revoking consent. Read and
acknowledge it, then update the root with `resolved_failures` and a **different,
concrete corrective `next_action`** before settling. Changing only its key is not
enough. The IDs must belong to acknowledged failed jobs/tasks or archived failed
Workflows in this grant; stopped/unknown results cannot be resolved this way. A job
and its linked leaf count as one attempt. For example, after inspecting/acknowledging
the indicated failure:

```json
{
  "action": "update",
  "id": "task-<root-uuid>",
  "resolved_failures": ["job-<failed-uuid>"],
  "next_action": {
    "key": "repair-fixture",
    "instruction": "Correct the fixture path identified in the failure log before fresh validation"
  },
  "summary": "Failure inspected; do not rerun the unchanged command"
}
```

This records a correction association, not proof that the correction works, a retry
scheduler, new permission or success. Failed history and failed dependencies remain
failed; old executors/leaves cannot be restarted. Recovery accounting must be saved
before automatic advancement. A paused/expired grant stays paused/expired even if
its failure checkpoint is updated. Existing `running` records are bookkeeping, not
authorization; paused plans may need result processing before explicit renewal.

The panel distinguishes `task:needs-continuation`, `task:waiting-job`, actual
`job:running`, and plan ready/waiting/awaiting-processing/paused/blocked states.
A checkpoint, an active executor, and a completed/accepted deliverable are different
facts. This mechanism does not prove that a model's completion claim is correct,
grant write access, or bypass normal tool approvals.

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
/tasks continue task-<root-uuid> 32 240
/tasks pause
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
  test/task-monitor-manager.test.ts test/suite/task-monitor.test.ts \
  test/task-continuation.test.ts test/task-activity.test.ts \
  test/suite/task-continuation.test.ts test/suite/agent-session-boundaries.test.ts
```

Tests use the faux provider and local processes, never paid model APIs. Real TUI
smoke additionally checks the existing trial binary's extension loader, actual
Escape, log-match notification after abort, continued chat while a worker remains
alive, log viewing, resize, and explicit worker termination with a loopback mock API.

# Workflow engineering plan

## User-approved scope (2026-10-12)

The user approved improving the audited Workflow, compaction, and project-engineering gaps in priority order, recording the work, and performing unified acceptance at the end. The user subsequently authorized committing and pushing each completed change to the remote so all changes remain recorded.

- Working branch: `feat/gpt-compaction-continuity`; push target: `origin/feat/gpt-compaction-continuity`.
- Implement in independently verifiable units. Run targeted offline tests for each code change and the full source check before committing. Stage only this session's explicit owned paths; do not force-push, bypass hooks, or include another session's work.
- Record verification evidence and commit references with each completed unit. A commit records a change; it does not by itself mean remote push, deployment, release, or unified acceptance passed.
- Preserve the current default read-only child policy and configured resource limits. Mode ON is not permission to relax write access, budgets, or sandbox policy.
- No deployment, formal release, tag, credential/configuration changes, or unrelated project changes without separate authorization.
- Workflow design/review children are read-only; implementation remains in the main agent. Keep investigations narrowly scoped instead of re-running the failed broad comparison.
- Offline/faux tests and loopback TUI tests must not call real provider APIs. Paid model A/B, especially Claude API calls, requires confirmation of provider/model, cases, and cost scope; it remains an explicit acceptance item, not an assumed pass.

## Baseline and confirmed gaps

Base commit: `b3bf81d97345faea0a7db525050eb08c002b4502`. The existing independently deployed Workflow foundation includes uncommitted/untracked changes owned by this session. Its 21-file deployment manifest matched the working tree before this implementation task. Historical verification: full source check, 69 targeted tests, real QuickJS/isolated Agent loops and Bun TUI with a loopback API. These are baseline results, not unified acceptance for the improvements below.

Current foundation: thinking/mode separation; branch-scoped consent; physical-model selection and downward-only effort; isolated Agent loops; QuickJS script API; lifecycle/result/acknowledgement records; role tool allowlists and double write opt-in. It remains independent of Codex Ultra.

Confirmed gaps:

1. Budget accounting is response-completion based; there is no request reservation or stage/child allocation, individual child usage, or usable interrupted progress snapshot.
2. All child roles use a minimal prompt/tool runner rather than role-selected project instructions, skills, MCP, or parent policy hooks. A canonical path guard is not an OS sandbox.
3. Child loops do not use the main session's compaction/recovery or durable transcript/authorized continuation.
4. Agent output is prose; ordinary failures reject and can abort siblings. There is no structured output contract or integrated implement/test/review evidence gate.
5. Branch summaries omit tool results and do not share the full main-compaction continuation contract.
6. Workflow and logical tasks are separate registries; ownership and integration gates remain manual. Current trial release tests do not explicitly include the new Workflow suite, and the feature is not yet a reproducible committed unit.
7. Named reusable workflows/agent definitions, detailed run inspection, and prefix-aware fan-out scheduling are absent.

The failed comparison run consumed 219270 reported tokens against a 200000 limit; all three scouts stopped without final reports. In-flight overshoot and counting cached input are documented. This is not evidence of context-window overflow, and compaction alone does not solve cumulative budget exhaustion. Its failed outcome remains archived, not rerun or reclassified as success.

## Work list and acceptance contracts

Statuses: `pending`, `designing`, `implementing`, `verified`, `committed`, `pushed`, `accepted`, or `blocked`. Do not use `accepted` until unified acceptance has been processed.

| ID | Priority | Work unit | Status | Acceptance contract |
|---|---|---|---|---|
| WF-00 | Baseline | Record this plan and the already-verified independent foundation in version control | verified | Owned baseline paths only; refreshed 69-test suite + full check; ordinary commit/hooks and successful branch push; no deployment |
| WF-01 | P0 | Budget admission, stage/child accounting, bounded evidence input and durable partial progress | designing | No config limit increase; reserve before requests; settle/release on success/error/abort; concurrent requests cannot all consume the same remaining reservation; expose cached/fresh/estimated usage; budget stop retains facts/progress/unknowns and does not retry |
| WF-02 | P0 | Role-specific project resources and shared tool policy boundary | pending | Explicit inheritance/deny matrix; applicable trusted instructions/skills without whole parent history; child calls pass appropriate parent/host policy with child cwd/role/ownership and lifetime; protected paths/denied operations remain denied; double write opt-in remains; unsupported sandbox/capabilities fail closed |
| WF-03 | P0 | Child compaction, transcript/checkpoint and explicitly authorized continuation | pending | Repeated/split compact preserves latest request, permissions, failed attempts and execution point; durable child history survives parent compact; stop/reload/unknown never auto-resumes; continuation preserves model/effort and does not duplicate completed mutations |
| WF-04 | P1 | Structured results, partial-failure isolation and execution/review evidence | pending | Validate schema before/after generation without unbounded retry; explicit success/partial/failed/stopped/unknown outcomes; parallel ordinary failure preserves successful siblings; no summary turns an unrun command/test into PASS; artifacts and truncation are explicit |
| WF-05 | P1 | Unified task/phase gates and scoped workspace/file ownership | pending | Workflow-to-logical-task linkage; completed execution is distinct from accepted work; dependency gates use processed outcomes; ownership checks prevent overlapping writes; isolated workspace support has an explicit host policy/cleanup contract, not silent shell access |
| WF-06 | P1 | Branch/main compaction continuity and failure-evidence consistency | pending | Same no-new-approval/no-revived-task contract; retain bounded relevant tool failure/outcome evidence and nested file-operation provenance; original role labels and interrupt handling remain; branch wrappers identify historical priority; tests cover rolling/split/branch/new correction |
| WF-07 | P1 | Reproducible package/version identity and CI/release acceptance matrix | pending | Commit-based source identity plus explicit build manifests; include Workflow/mode/task-monitor/compact regressions in appropriate gates; verify source/Node/Bun/TUI/RPC/reload combinations without replacing live installation; no release/deployment implied |
| WF-08 | P1 | Fixed-scenario model/engineering evaluation harness | pending | Offline deterministic scenarios first; report goal drift, constraint omission, duplicated work, test evidence, interruption, tokens and partial recovery; real-provider comparison remains blocked until cost/model scope is confirmed; no parity score from mock results |
| WF-09 | P2 | Project/user named workflows and agent definitions | pending | Reviewed declarative discovery/precedence and input validation; no arbitrary module/URL/credential injection; reuse a saved orchestration without silently enabling mode or writes; definitions remain independent of Ultra |
| WF-10 | P2 | Detailed run/Agent inspection | pending | Query prompt, bounded tool trace, per-agent usage, checkpoints and artifacts; preserve untrusted-output markers and redaction/size limits; equivalent machine-readable inspection works outside TUI |
| WF-11 | P2 | Prefix-aware scheduling/cost optimization | pending | Match only compatible model/effort/tools/schema/cwd prefixes; bounded cancellable stagger; no timers/polling model turns; do not claim real cache hits from mocked traffic; does not relax concurrency or approval limits |

Dependencies: WF-01 before expanding long-running child work; WF-02 before enabling broader child capabilities; WF-03/04 before resume/structured delivery gates; WF-06 may be developed independently; WF-07/08 assemble the unified matrix after the feature contracts stabilize. P2 must not delay fixing demonstrated P0 failures or require unsafe default permissions.

## Implementation rules

- Prefer shared runtime/policy/compaction facilities where their lifetime and state ownership are correct. Do not borrow the expired launch-turn signal, load all parent executable extensions twice, or copy credentials/history into child prompts.
- Every new capability must state its host authorization boundary, resource limits, cancellation semantics and persistence contract.
- Keep API compatibility claims narrow. Claude public docs include capabilities introduced after local 2.1.224; version-specific features are not automatically that baseline's behavior.
- Persistent records are evidence, not authority to resume. A new user instruction can authorize a new bounded implementation phase; a ready event cannot.
- No automatic retry of writing work without idempotency/ownership and fresh authorization. Preserve actual failure/unknown outcomes after acknowledging.

## Verification and commit ledger

For each unit record: changed paths, targeted tests and counts, full-check result, code-review findings/resolution, actual commit hash, push result, artifacts, remaining boundaries. Reference the previous commit from a later ledger update rather than inventing a self-referential commit hash.

| Unit | Verification | Commit / push | Boundary |
|---|---|---|---|
| WF-00 | 2026-10-12: full `npm run check` passed with no formatter changes; 5 targeted files / 69 tests passed; `git diff --check` passed. Logs: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf00/{check,regression}.log` | commit/push pending; subsequent unit will reference the actual baseline hash | foundation remains a subset; refreshed baseline verification is not unified acceptance |

## Processed P0 design findings

The bounded read-only design run `workflow-e893cd49-72bf-4a79-9633-09d5265830dd` completed with two agents, two requests each, medium effort, 19599 reported tokens. It was processed and archived as a design result, not implementation or acceptance.

WF-01 implementation direction:

- A request-ID ledger owns actual usage, outstanding reservations and unknown-usage reservations. Admission rechecks after pause/queue waits and atomically reserves without an intervening await.
- Estimate the actual request context plus output limit and explicit margin. Estimates are not a hard provider billing guarantee. Do not increase the configured total limit.
- Settle idempotently by request ID. Confirmed unsent requests can release fully; sent requests with missing usage remain unknown and conservatively retain their reservation. Late results keep their original phase/child ownership.
- Persist bounded completed-message and tool-operation checkpoints before applying an over-budget cancellation. Preserve interrupted output as partial, and writing operations as completed/failed/unknown rather than assuming rollback.
- Ordinary failure aggregation and any retry are explicit; cancellation/budget stop must not depend on the script finishing a summarizer.

WF-02/03 candidate designs remain unresolved: a filtered AgentSession versus a controlled child-session adapter. Main-agent review must check resource loading, shared policy dispatch, all model requests (including compaction), model-runtime authentication access and independent lifetime. Do not infer compact/policy inheritance from merely changing the constructor.

## Unified acceptance (pending)

1. Run the combined offline Workflow/mode/task/background/compact/branch/interruption regressions; no live endpoint/auth activation.
2. Run the full source check and whitespace check, and verify all newly added tests pass.
3. Exercise real QuickJS plus isolated child runtimes: budget race/abort, failed sibling preservation, partial checkpoint retrieval, role/policy denial, ownership, compaction/continuation, unknown restoration and result acknowledgement.
4. Exercise loopback-backed source/Node/standalone Bun TUI and RPC: mode on/off, mid-turn changes, reload, child effort, visible failure/partial progress and retained backlog. Building a candidate is not deployment.
5. Verify git ownership/cleanliness, commit/push history, source/lock/build fingerprints, package identity and rollback instructions. Do not adopt others' changes.
6. Mark separately any real-model/caching/Claude-runtime evaluation not run. User acceptance must not hide such exclusions.
7. Only after results are read and processed, issue a single final acceptance report listing passes, failures, skipped/blocked cases and remaining work. No automatic formal release or installation replacement.

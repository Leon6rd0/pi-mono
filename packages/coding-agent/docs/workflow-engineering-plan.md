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
| WF-00 | Baseline | Record this plan and the already-verified independent foundation in version control | pushed | Owned baseline paths only; refreshed 69-test suite + full check; ordinary commit/hooks and successful branch push; no deployment |
| WF-01 | P0 | Budget admission, stage/child accounting, bounded evidence input and durable partial progress | pushed | No config limit increase; reserve before requests; settle/release on success/error/abort; concurrent requests cannot all consume the same remaining reservation; expose cached/fresh/estimated usage; budget stop retains facts/progress/unknowns and does not retry |
| WF-02 | P0 | Role-specific project resources and shared tool policy boundary | implementing | Explicit inheritance/deny matrix; applicable trusted instructions/skills without whole parent history; child calls pass appropriate parent/host policy with child cwd/role/ownership and lifetime; protected paths/denied operations remain denied; double write opt-in remains; unsupported sandbox/capabilities fail closed |
| WF-03 | P0 | Child compaction, transcript/checkpoint and explicitly authorized continuation | pending | Repeated/split compact preserves latest request, permissions, failed attempts and execution point; durable child history survives parent compact; stop/reload/unknown never auto-resumes; continuation preserves model/effort and does not duplicate completed mutations |
| WF-04 | P1 | Structured results, partial-failure isolation and execution/review evidence | pending | Validate schema before/after generation without unbounded retry; explicit success/partial/failed/stopped/unknown outcomes; parallel ordinary failure preserves successful siblings; no summary turns an unrun command/test into PASS; artifacts and truncation are explicit |
| WF-05 | P1 | Unified task/phase gates and scoped workspace/file ownership | pending | Workflow-to-logical-task linkage; completed execution is distinct from accepted work; dependency gates use processed outcomes; ownership checks prevent overlapping writes; isolated workspace support has an explicit host policy/cleanup contract, not silent shell access |
| WF-06 | P1 | Branch/main compaction continuity and failure-evidence consistency | pending | Same no-new-approval/no-revived-task contract; retain bounded relevant tool failure/outcome evidence and nested file-operation provenance; original role labels and interrupt handling remain; branch wrappers identify historical priority; tests cover rolling/split/branch/new correction |
| WF-07 | P1 | Reproducible package/version identity and CI/release acceptance matrix | pending | Commit-based source identity plus explicit build manifests; include Workflow/mode/task-monitor/compact regressions in appropriate gates; verify source/Node/Bun/TUI/RPC/reload combinations without replacing live installation; no release/deployment implied |
| WF-08 | P1 | Fixed-scenario model/engineering evaluation harness | pending | Offline deterministic scenarios first; report goal drift, constraint omission, duplicated work, test evidence, interruption, tokens and partial recovery; real-provider comparison remains blocked until cost/model scope is confirmed; no parity score from mock results |
| WF-09 | P2 | Project/user named workflows and agent definitions | pending | Reviewed declarative discovery/precedence and input validation; no arbitrary module/URL/credential injection; reuse a saved orchestration without silently enabling mode or writes; definitions remain independent of Ultra |
| WF-10 | P2 | Detailed run/Agent inspection (token visibility subset promoted by the user's additional request) | implementing | Query prompt, bounded tool trace, per-agent usage, checkpoints and artifacts; preserve untrusted-output markers and redaction/size limits; equivalent machine-readable inspection works outside TUI |
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
| WF-00 | 2026-10-12: full `npm run check` passed with no formatter changes; 5 targeted files / 69 tests passed; `git diff --check` passed. Logs: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf00/{check,regression}.log` | `259e99db819fa370b655c1bdeba02804dd8d9498`; pushed to origin feature branch; remote SHA matched local SHA | foundation remains a subset; refreshed baseline verification is not unified acceptance |

### WF-01a / WF-10a implementation (pushed)

Additional user requirement: running workflows must show token consumption, with per-Agent and per-model-request numbers. This observation promotes the usage subset of WF-10 into the current WF-01 work; it does not promote all P2 features or authorize deployment.

- New `workflow/budget.ts` provides a bounded atomic reservation ledger with scope limits, request identity, cached-token accounting, unknown-usage debit and idempotent late settlement. Runtime admission is not wired yet; do not claim this alone fixed budget exhaustion.
- `types.ts`, `manager.ts` and `child-agent.ts` collect live cumulative child usage and bounded sequential request records; synthetic pre-dispatch errors do not invent model requests. Interrupt/reload changes outstanding request observations to unknown, without retry.
- `usage-view.ts` and `index.ts` put reported token counts ahead of labels in the running TUI widget/footer and expose request input/output/cache/total/cost data in status/results. Cumulative already-reported usage is separate from pending/unknown requests; no fake streaming billing estimate. Historical missing child/request data remains unavailable.
- r1 validation: full `npm run check` and 7 targeted files / 106 tests passed; BiOME formatted six owned files. Evidence: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf01a/{check,regression}-r1.log`. This result does not cover subsequent review remediation.
- Processed independent review `workflow-7b1bdd06-cd22-44d7-acc1-e3a0b77ac6d5`: two medium-effort reviewers, two requests each, 18512 reported tokens. Ledger invariants had no confirmed finding. Main agent checked the full host `agent.ts`/`agent-loop.ts` rather than relying on child assumptions. Remediation: immediate queue persistence; provider-handoff counters survive failure/stop; prioritize all running children; explicit trusted usage observations distinguish confirmed zero from default/unknown zero. Provider acceptance/billing is not inferred from a handoff count.
- r2 validation: full `npm run check` and 7 targeted files / 111 tests passed; BiOME formatted five owned files; `git diff --check` passed. Evidence: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf01a/{check,regression}-r2.log`. New assertions cover confirmed-zero, queue persistence, dispatch attempts retained on stop/turn-limit failure, all four running children and bounded scopes. Submitted and pushed as `9ecf8337c5f09a441e81681f3762cde5ed0eed91`; remote SHA matched. Explicit `.husky/pre-commit` execution passed with no formatter changes; evidence: `wf01a/pre-commit.log` and `wf01a/commit-push-result.txt`. Native all-zero usage without provenance remains conservative unknown; no provider contract can be invented by this UI change.
- The existing Git configuration has no `core.hooksPath` binding for `.husky/pre-commit`. Subsequent submissions will explicitly run the repository's hook script before ordinary commits, keeping evidence without changing Git configuration. WF-00 independently passed the full check; automatic hook execution was not claimed as separately observed.

### WF-01b implementation (pushed)

Request-context estimation, runtime atomic reservation and ID-based settlement are connected and verified in source. `agent(...,{maxTotalTokens})` and `phase(title,{maxTotalTokens})` can narrow scope limits; phase IDs keep late usage attached to its original owner. Local admission waits only on potentially sufficient real settlements, rechecks pause/cancel after asynchronous gates, retains unknown debits and releases only confirmed unsent requests. No defaults are raised or failed work retried.

New `request-context.ts`, `progress.ts` and `records.ts` provide exact-context estimates, bounded completed-message/tool checkpoints and persistence validation. Child observations are saved before usage-triggered cancellation and remain untrusted partial evidence, not test/file success or continuation authority. Live usage displays separate reservation estimates from API-reported actuals. Trusted host runner callbacks now require admission estimates and request IDs; external trusted network code is not sandboxed by this contract.

Targeted additions: request/context estimator tests, bounded checkpoint/mutation-unknown tests, and real QuickJS/faux child admission/settlement/partial retrieval scenarios.

- r1 full check failed at TypeScript: two AI estimate functions are exposed by `pi-ai/utils/estimate`, not the package root; tests must use `normalizeContext` for branded transcripts; tool results need unknown-safe content checks. BiOME formatted 12 owned files. Other pre-TypeScript checks passed; browser smoke and Vitest did not run. Evidence: `wf01b/check-r1.log`. Fixed source issues before scheduling a changed r2 run, not an unchanged retry.
- Processed review `workflow-40c3018e-58dd-49fc-995a-48ece963eaf5`: two medium reviewers/two requests each, 27159 reported tokens. Confirmed corrections: force usage IDs; use canonical records for result/ack so late callbacks cannot erase lifecycle state; detect actual-plus-outstanding overcommit separately from actual overspend and individual estimate error. Add tests for late correction after archive, pause/settlement gates, missing IDs, and fixed original phase ownership.
- Review's suggestion to remove unknown amounts from reserved totals was rejected after checking `budget.ts`: unknown is deliberately a reserved subset; doing so would refund potentially billed requests. Added reload assertions across workflow/agent/phase scopes instead. Restore never starts a new ledger runtime.
- Added bounded-output truncation flags and known original character lengths, delivery completeness distinct from script success, and usage source/completeness/late-correction markers. Full structured outcomes/failure isolation remain WF-04. Codemode may truncate upstream and omit the original length; its spill metadata and conservative warning detection expose incompleteness without claiming full artifact support.

- r2 full `npm run check` passed (including TypeScript/browser smoke); 11 owned files formatted. Offline regression: 8/9 files passed, 142/143 tests passed. Sole failure: real-child budget checkpoint fixture manually set `response.usage`, but `faux.ts` deliberately recomputes usage, so it never exceeded the limit. This is not a passing test or a production cancellation fix. Evidence: `wf01b/{check,regression}-r2.log`. The corrected fixture uses faux's actual calculated output usage to model overshoot, still requires failed outcome, and checks bounded head/tail progress plus actual-versus-reserved counts. Added tool-declaration/replay context and unavailable/restored usage completeness tests.

- r3 validation: full `npm run check` passed; 9 targeted test files / 146 tests passed; `git diff --check` passed. BiOME formatted three owned test files. Evidence: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf01b/{check,regression}-r3.log`. This validates runtime reservation races, real-settlement waits and pause gates, unsent versus unknown, original phase/child limits, idempotent late usage and archive preservation, overcommit cancellation, request-context bounds including tools/replay, bounded partial observations, restored unknown debits, and truncation/accounting completeness. Feature tests used only local/faux providers; the separately recorded design/review Workflow calls did consume model tokens.

WF-01 is source-verified, not accepted by the pending unified matrix. Submitted and pushed as `e21d35dbb385f369835499268deb2a8a00f56c18`; remote SHA matched. Explicit `.husky/pre-commit` passed with no formatter changes; all 18 owned paths matched their pre-hook SHA256 manifest, and the post-commit worktree was clean. Evidence: `wf01b/pre-commit.log`, `wf01b/owned-before-hook.sha256`, and `wf01b/commit-push-result.txt`. Full transcripts/compaction/controlled continuation remain WF-03; broader prompt/artifact inspection remains WF-10. Native token estimates remain heuristic, not a hard billing guarantee; unknown debits are not refunded, and a late post-result correction is visible without being automatically re-billed to the parent. Installed/live binaries are unchanged; source changes require authorized deployment to appear there.

## Processed P0 design findings

The bounded read-only design run `workflow-e893cd49-72bf-4a79-9633-09d5265830dd` completed with two agents, two requests each, medium effort, 19599 reported tokens. It was processed and archived as a design result, not implementation or acceptance.

WF-01 implementation direction:

- A request-ID ledger owns actual usage, outstanding reservations and unknown-usage reservations. Admission rechecks after pause/queue waits and atomically reserves without an intervening await.
- Estimate the actual request context plus output limit and explicit margin. Estimates are not a hard provider billing guarantee. Do not increase the configured total limit.
- Settle idempotently by request ID. Confirmed unsent requests can release fully; sent requests with missing usage remain unknown and conservatively retain their reservation. Late results keep their original phase/child ownership.
- Persist bounded completed-message and tool-operation checkpoints before applying an over-budget cancellation. Preserve interrupted output as partial, and writing operations as completed/failed/unknown rather than assuming rollback.
- Ordinary failure aggregation and any retry are explicit; cancellation/budget stop must not depend on the script finishing a summarizer.

WF-02/03 candidate designs remain unresolved: a filtered AgentSession versus a controlled child-session adapter. Main-agent review must check resource loading, shared policy dispatch, all model requests (including compaction), model-runtime authentication access and independent lifetime. Do not infer compact/policy inheritance from merely changing the constructor.

## WF-02 design checkpoint (not implementation)

Processed read-only design run `workflow-37790cbf-510f-4f32-8b78-2693fa8dc134`: two medium-effort scouts, two and three requests respectively, 54097 reported tokens. Main-agent verification also read the full `src/core/{sdk,resource-loader,trust-manager,nested-tool-calls,agent-session}.ts`. These findings are static evidence, not tests or runtime inheritance.

Confirmed integration constraints:

- `DefaultResourceLoader.reload()` resolves packages and loads extensions before `extensionsOverride` filters the result; `noExtensions` / `noSkills` do not remove explicit CLI/factory resources. Do not load executable resources and then call filtering isolation. `loadProjectContextFiles()` reads global/ancestor context independently of project trust. `ProjectTrustStore.getEntry()` uses a filesystem lock; it is not a pure in-memory trust query.
- `AgentSession._executeNestedToolCall()` uses the parent's latest assistant message, transcript, callable tools and hook pipeline. `_handleAgentEvent()` consumes nested records on tool results and clears them at parent `agent_end`. `ExtensionRunner.createToolContext()` is therefore not a detached-child executor simply because a different abort signal is passed.
- `_beforeToolCall()` and `_afterToolCall()` are the actual shared hook entry points; `wrapRegisteredTool()` / `wrapToolDefinition()` alone do not provide those permission checks. `_bindExtensionCore()` binds trust, model, cwd-related context and lifecycle to the session; a child needs explicit, correct ownership rather than a spread of the launch context.
- Switching directly to default `createAgentSession()` would also introduce resource discovery, transcript projection, retry and compaction paths. These extra model calls and lifecycle changes are outside the verified WF-01 request contract until explicitly integrated.

Selected implementation direction: retain the independent raw Agent loop for WF-02, and add a core-owned child capability scope for resource snapshots and shared policy dispatch. This is a proposed new contract, not an existing API. Implement the core boundary with deterministic tests, then wire Workflow to it and test real faux child execution. Do not mark WF-02 complete when only a mock adapter or type interface exists. WF-03 will separately decide session/compaction integration.

| Input / capability | Child inheritance contract to implement |
| --- | --- |
| Applicable project instructions | Explicit host-selected content snapshot with path/provenance and bounded size; retain applicable constraints across roles; never silently truncate rules or copy the whole parent system prompt/history |
| Skills | Role selection may only narrow the host-authorized catalog; project skills require the effective trust decision for the child cwd, including session-only decisions; no package/extension/MCP discovery side effects |
| Different cwd | Do not reuse the parent's trust decision, bound tool implementation or instruction set as proof; require an explicit host resolution for that canonical scope, otherwise fail closed |
| Read tools | Intersect role policy and captured host capability ceiling; run shared deny/approval checks with child identity, cwd, arguments and independent signal; do not import shell/MCP/delegation capabilities |
| Edit/write | Preserve launch plus trusted-config double permission; also require shared policy authorization; role selection never grants access |
| Custom backends / sandbox | Preserve supported host semantics, or explicitly reject unsupported inheritance; never replace a denied/unknown backend with local filesystem tools |
| Live policy and lifetime | Revocation applies before dispatch and after asynchronous approval/queue waits; new permissions are not silently added; child stop/reload/dispose closes its scope and drains owned work without cancelling the parent's turn |
| Evidence and accounting | Own child records independently of the launching tool result; keep tool failures/unknown side effects and WF-01 request budgets; no duplicate parent billing or automatic replay |

Required offline tests: denied calls execute zero times; approval error/unavailable UI fails closed; caller signal cannot defeat child cancellation; launch-turn completion/parent new turn does not steal child cwd or records; reload/close rejects stale scopes; dynamic revocation after queued approval; protected paths and unsupported custom backend rejection; trust/role/cwd resource filtering and bounded prompts; parent-history/credential sentinel exclusion; zero extension/package/MCP restarts; real child loops preserve the 146-test WF-01 baseline. These tests have not yet been implemented or run for WF-02. No permissions, trusted configuration, deployed artifacts, or default budgets changed at this checkpoint.

### WF-02a core primitives (verified; submission pending)

The design checkpoint was committed and pushed as `25385946852f9aaf24c99a1e48a904f631b46665`. Implementation now proceeds in two verifiable units: core resource/tool scope primitives first, then the AgentSession/ExtensionRunner host adapter and real Workflow child integration. **WF-02 is not complete until the latter passes the real-child acceptance matrix.**

- `src/core/child-resources.ts`: explicit host-resolved cwd/epoch/trust, provenance-bearing instructions retained for every role, explicitly selected role/trust-filtered skills, immutable snapshots and SHA256 identity. Exact UTF-8 prompt/count bounds reject rather than truncate constraints. No filesystem discovery or executable resource loading; arbitrary parent-history/credential fields are not copied. This is not a secret scanner for host-selected content.
- `src/core/child-tool-scope.ts`: captured tool ceiling intersected with role and both write permissions; mandatory host policy adapter, no synthesized local tools; independent signal/IDs, serial queue, repeated-ID rejection and bounded records. Check live state/protected paths before and after asynchronous approval and after result filtering. Observed revocations cannot be re-added within the scope. Backend/resource/session epoch changes invalidate the scope.
- Results must pass the host filter; raw partial updates are intentionally not forwarded. Records distinguish backend observations, result delivery and possible side effects. Cancellation is not rollback; close rejects new work immediately, but drain waits for actual settlement and can be delayed by an uncooperative host.
- Host responsibilities remain explicit: resolve canonical cwd and effective trust, bind tools to the correct supported backend, supply shared authorization/result hooks, and invalidate epochs for policy changes that cannot be checked synchronously. These primitives do not inspect a parent session, discover skills, or automatically inherit a sandbox.
- New deterministic tests are `test/child-resources.test.ts` and `test/child-tool-scope.test.ts`. Do not treat these mock host tests as proof of production shared-policy wiring. The existing Workflow runner is unchanged in this unit and still has the previously documented boundary until WF-02b replaces its local construction with the core host adapter.

- r1 full check failed at TypeScript: the pre-validation argument type at the `validateToolArguments` boundary must be `JsonObject`, not `Record<string, unknown>`. Earlier checks passed with no formatter modifications; browser smoke and tests did not run. Evidence: `/rivai/20-builds/pi-mono/workflow-engineering-20261012/wf02a/check-r1.log`. Corrected the boundary type without weakening runtime schema validation.
- r2 validation passed: full `npm run check` with no formatter changes, 11 targeted files / 188 tests, and `git diff --check`. This covers the 146-test baseline plus 42 primitive tests, before the following review remediation. Evidence: `wf02a/{check,regression}-r2.log`.
- Processed independent review `workflow-ca2d8e3b-7f38-43e0-b12c-59db5666fdf3`: two medium reviewers, five and three requests, 33895 reported tokens. Resource reviewer found no confirmed issue. Main-agent verification accepted the tool review finding: a sanitized error message still exposed the original backend exception through `Error.cause`. Removed the cause chain and sanitized initial host-state exceptions; added six tests for backend/state/check/approval/result exception objects and constructor failures. The earlier 188-test result does not cover this correction.
- r3 post-remediation validation passed: full `npm run check` (including TypeScript and browser smoke) with no formatter changes; 11 targeted files / 194 tests passed (146 baseline plus 48 primitive cases); `git diff --check` passed. Evidence: `wf02a/{check,regression}-r3.log`. This verifies the core unit, not production host integration, the entire repository test suite or unified acceptance. Submission will stage only the two new core files, their two test files, `src/index.ts` exports and this plan.

No deployment, credentials, trusted configuration, default Workflow budgets or live child permissions changed.

## Unified acceptance (pending)

1. Run the combined offline Workflow/mode/task/background/compact/branch/interruption regressions; no live endpoint/auth activation.
2. Run the full source check and whitespace check, and verify all newly added tests pass.
3. Exercise real QuickJS plus isolated child runtimes: budget race/abort, failed sibling preservation, partial checkpoint retrieval, role/policy denial, ownership, compaction/continuation, unknown restoration and result acknowledgement.
4. Exercise loopback-backed source/Node/standalone Bun TUI and RPC: mode on/off, mid-turn changes, reload, child effort, visible failure/partial progress and retained backlog. Building a candidate is not deployment.
5. Verify git ownership/cleanliness, commit/push history, source/lock/build fingerprints, package identity and rollback instructions. Do not adopt others' changes.
6. Mark separately any real-model/caching/Claude-runtime evaluation not run. User acceptance must not hide such exclusions.
7. Only after results are read and processed, issue a single final acceptance report listing passes, failures, skipped/blocked cases and remaining work. No automatic formal release or installation replacement.

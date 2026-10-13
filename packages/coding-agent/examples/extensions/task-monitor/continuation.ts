import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { WorkflowActivity } from "./activity.ts";
import type { TaskCheckpoint, TaskManager, TaskRecord } from "./manager.ts";

export const CONTINUITY_ENTRY = "task-continuity-consent-v1";
export const CONTINUITY_MESSAGE = "task-continuity-step-v1";
export const CONTINUITY_LIMITS = Object.freeze({
	defaultContinuations: 32,
	maxContinuations: 128,
	defaultDurationMinutes: 240,
	maxDurationMinutes: 1440,
	maxNoProgress: 2,
});

const planSchema = Type.Object({
	version: Type.Literal(1),
	rootId: Type.String({ maxLength: 100 }),
	receipt: Type.String({ maxLength: 100 }),
	source: Type.Union([Type.Literal("user-command"), Type.Literal("user-confirmation")]),
	scope: Type.String({ maxLength: 500 }),
	state: Type.Union([
		Type.Literal("armed"),
		Type.Literal("paused"),
		Type.Literal("blocked"),
		Type.Literal("completed"),
	]),
	reason: Type.Optional(Type.String({ maxLength: 1000 })),
	approvedAt: Type.Number(),
	expiresAt: Type.Number(),
	limit: Type.Integer({ minimum: 1, maximum: CONTINUITY_LIMITS.maxContinuations }),
	used: Type.Integer({ minimum: 0, maximum: CONTINUITY_LIMITS.maxContinuations }),
	resolvedFailures: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 2000 })),
	stalled: Type.Integer({ minimum: 0, maximum: 2 }),
	lastFingerprint: Type.Optional(Type.String({ maxLength: 100 })),
	workflowIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 1000 }),
	notified: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 1000 }),
});
export type ContinuityPlan = Static<typeof planSchema>;
export interface ContinuityView {
	plan?: ContinuityPlan;
	state: "off" | "ready" | "waiting" | "awaiting_processing" | "paused" | "blocked" | "completed";
	reason?: string;
	waitingOn: string[];
}

/** No processes or model requests here. This ledger only reserves bounded boundary messages. */
export class TaskContinuation {
	private readonly manager: TaskManager;
	private plan: ContinuityPlan | undefined;
	private readonly now: () => number;

	constructor(manager: TaskManager, now: () => number = Date.now) {
		this.manager = manager;
		this.now = now;
		const path = manager.continuityPath();
		if (!existsSync(path)) return;
		try {
			if (statSync(path).size > 262_144) throw new Error("Continuity file too large");
			const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!Check(planSchema, stored)) throw new Error("Invalid continuity state");
			this.plan = stored;
			// A receipt is evidence of prior approval, never an automatic restart lease.
			if (stored.state !== "completed")
				this.persist({
					...stored,
					state: "paused",
					reason: "Reload/restart: inspect the checkpoint and explicitly resume; old work was not replayed",
				});
		} catch {
			this.plan = undefined;
			// Preserve corrupt/unknown evidence. New activation must be explicit.
		}
	}

	private persist(plan: ContinuityPlan): void {
		if (!Check(planSchema, plan)) throw new Error("Invalid continuity state");
		const encoded = JSON.stringify(plan);
		if (Buffer.byteLength(encoded) > 262_144) throw new Error("Continuity ledger size limit exceeded");
		const path = this.manager.continuityPath();
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, encoded, { mode: 0o600 });
		renameSync(temporary, path);
		this.plan = plan;
	}

	snapshot(): ContinuityPlan | undefined {
		return this.plan ? structuredClone(this.plan) : undefined;
	}

	/** Non-mutating preflight: invalid requests must not overwrite branch consent. */
	validateActivation(rootId: string, limit: number, durationMinutes: number): void {
		const task = this.manager.get(rootId);
		if (task.kind !== "task" || task.parentTaskId || task.review || !["pending", "running"].includes(task.status))
			throw new Error("Continuation requires an active root task");
		if (!task.nextAction || task.blockedReason)
			throw new Error("Record an unblocked next_action checkpoint before enabling continuation");
		if (!Number.isInteger(limit) || limit < 1 || limit > CONTINUITY_LIMITS.maxContinuations)
			throw new Error(`Continuation limit must be 1–${CONTINUITY_LIMITS.maxContinuations}`);
		if (
			!Number.isInteger(durationMinutes) ||
			durationMinutes < 1 ||
			durationMinutes > CONTINUITY_LIMITS.maxDurationMinutes
		)
			throw new Error(`Continuation duration must be 1–${CONTINUITY_LIMITS.maxDurationMinutes} minutes`);
		if (this.manager.descendants(rootId).some((entry) => entry.kind === "job" && entry.review !== "acknowledged"))
			throw new Error("Inspect and process existing executors before activation; unknown work cannot be resumed");
		if (this.plan?.state === "armed" && this.plan.rootId !== rootId)
			throw new Error("Pause the other active plan first");
	}

	/** Called only by a user command or fresh UI confirmation, never by update/restore. */
	activate(
		rootId: string,
		receipt: string,
		source: ContinuityPlan["source"],
		limit: number = CONTINUITY_LIMITS.defaultContinuations,
		durationMinutes: number = CONTINUITY_LIMITS.defaultDurationMinutes,
	): ContinuityPlan {
		this.validateActivation(rootId, limit, durationMinutes);
		const task = this.manager.get(rootId);
		const now = this.now();
		this.persist({
			version: 1,
			rootId,
			receipt,
			source,
			scope: task.label,
			state: "armed",
			approvedAt: now,
			expiresAt: now + durationMinutes * 60_000,
			limit,
			used: 0,
			stalled: 0,
			workflowIds: [],
			notified: [],
			resolvedFailures: [],
		});
		return this.snapshot()!;
	}

	private failures(workflows: WorkflowActivity[]) {
		const plan = this.plan!;
		return [
			...this.manager
				.descendants(plan.rootId)
				.filter((entry) => entry.createdAt >= plan.approvedAt && (entry.resultStatus ?? entry.status) === "failed")
				.map((entry) => ({ id: entry.id, processed: entry.review === "acknowledged", taskId: entry.taskId })),
			...workflows
				.filter((entry) => plan.workflowIds.includes(entry.id) && entry.outcome === "failed")
				.map((entry) => ({ id: entry.id, processed: entry.status === "archived", taskId: undefined })),
		];
	}

	/** Associate processed failures with an explicit corrective checkpoint, never a retry or a new grant. */
	recordRecovery(
		rootId: string,
		ids: string[],
		checkpoint: TaskCheckpoint,
		workflows: WorkflowActivity[] | undefined,
	): TaskRecord {
		const plan = this.plan;
		if (!plan || plan.rootId !== rootId || plan.state === "completed" || !workflows)
			throw new Error("Failure recovery requires the recorded plan and a known Workflow adapter");
		const previous = this.manager.get(rootId).nextAction;
		const next = checkpoint.nextAction;
		if (!next?.instruction.trim() || next.instruction.trim() === previous?.instruction.trim())
			throw new Error(
				"Record a different corrective next_action instruction; changing only its key is insufficient",
			);
		if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
			throw new Error("resolved_failures requires 1–50 distinct failed executor IDs");
		const failures = this.failures(workflows);
		for (const id of ids) {
			if (!failures.some((entry) => entry.id === id && entry.processed))
				throw new Error(
					"Read and acknowledge each failed result before recording recovery; stopped/unknown are not failures to resolve",
				);
		}
		// A job and its linked logical leaf are two records of the same failed attempt.
		const resolved = new Set([...(plan.resolvedFailures ?? []), ...ids]);
		for (const entry of failures) {
			if (entry.taskId && (resolved.has(entry.id) || resolved.has(entry.taskId))) {
				resolved.add(entry.id);
				resolved.add(entry.taskId);
			}
		}
		// Checkpoint first: if durable resolution accounting fails, advancement remains blocked.
		const task = this.manager.updateTask(rootId, undefined, checkpoint);
		this.persist({ ...plan, resolvedFailures: [...resolved] });
		return task;
	}

	pause(reason: string): void {
		if (!this.plan || this.plan.state === "completed") return;
		// Revoke the live lease even if storage fails. Restore also always requires fresh opt-in.
		this.plan = { ...this.plan, state: "paused", reason: reason.slice(0, 1000) };
		this.persist(this.plan);
	}

	trackWorkflows(workflows: WorkflowActivity[] | undefined): void {
		if (!this.plan || this.plan.state !== "armed" || !workflows) return;
		const workflowIds = [
			...new Set([
				...this.plan.workflowIds,
				...workflows.filter((entry) => entry.createdAt >= this.plan!.approvedAt).map((entry) => entry.id),
			]),
		];
		if (workflowIds.length !== this.plan.workflowIds.length) this.persist({ ...this.plan, workflowIds });
	}

	/** A real terminal event may spend one prompt to process a result, not replay its work. */
	reserveEvent(ids: string[], receipt: string | undefined): boolean {
		if (!this.plan || this.plan.state === "completed") return true;
		const owned = new Set([
			...this.manager.descendants(this.plan.rootId).map((entry) => entry.id),
			...this.plan.workflowIds,
		]);
		if (!ids.some((id) => owned.has(id))) return true;
		if (this.plan.state !== "armed" || receipt !== this.plan.receipt) return false;
		if (this.now() >= this.plan.expiresAt || this.plan.used >= this.plan.limit) {
			this.pause("Continuation event/time limit reached; explicit renewal required");
			return false;
		}
		// Deduplicate individual executor IDs, not a batch hash: [A,B] followed by [A]
		// must not spend another prompt just because the batching changed.
		const fresh = [...new Set(ids.filter((id) => owned.has(id) && !this.plan!.notified.includes(id)))];
		if (!fresh.length) return false;
		this.persist({ ...this.plan, used: this.plan.used + 1, notified: [...this.plan.notified, ...fresh] });
		return true;
	}

	view(workflows: WorkflowActivity[] | undefined): ContinuityView {
		const plan = this.snapshot();
		const base = { plan, waitingOn: [] as string[] };
		if (!plan) return { ...base, state: "off" };
		if (plan.state !== "armed") return { ...base, state: plan.state, reason: plan.reason };
		let root: TaskRecord;
		try {
			root = this.manager.get(plan.rootId);
		} catch {
			return { ...base, state: "blocked", reason: "Plan task is missing" };
		}
		if (root.status === "completed" && root.review === "acknowledged") return { ...base, state: "completed" };
		if (root.review || !["pending", "running"].includes(root.status))
			return { ...base, state: "blocked", reason: "Plan was stopped or failed" };
		if (root.label !== plan.scope) return { ...base, state: "blocked", reason: "Approved task scope changed" };
		if (root.blockedReason) return { ...base, state: "blocked", reason: root.blockedReason };
		if (this.now() >= plan.expiresAt)
			return { ...base, state: "paused", reason: "Continuation time limit reached; explicit renewal required" };
		if (plan.used >= plan.limit)
			return { ...base, state: "paused", reason: "Continuation count limit reached; explicit renewal required" };
		if (!workflows)
			return {
				...base,
				state: "blocked",
				reason: "Workflow activity adapter unavailable; refusing to guess executor state",
			};
		const owned = this.manager.descendants(plan.rootId);
		const unsafe = owned.find(
			(entry) =>
				entry.status === "unknown" ||
				entry.resultStatus === "unknown" ||
				(entry.createdAt >= plan.approvedAt && (entry.resultStatus ?? entry.status) === "stopped"),
		);
		const unsafeWorkflow = workflows.find(
			(entry) => plan.workflowIds.includes(entry.id) && (entry.outcome === "unknown" || entry.outcome === "stopped"),
		);
		if (unsafe || unsafeWorkflow)
			return {
				...base,
				state: "blocked",
				reason: `Inspect stopped/unknown work ${unsafe?.id ?? unsafeWorkflow?.id}; no automatic replay`,
			};
		const unresolved = this.failures(workflows).filter((entry) => !plan.resolvedFailures?.includes(entry.id));
		if (unresolved.length)
			return {
				...base,
				state: "awaiting_processing",
				waitingOn: unresolved.map((entry) => entry.id),
				reason:
					"Read/acknowledge failed results, then tasks update with resolved_failures and a different corrective next_action; never replay unchanged work",
			};
		// Conservative session-wide Workflow gate: there is no claim that another extension's
		// detached executor belongs to this plan simply because its label looks related.
		const live = [
			...owned.filter((entry) => entry.kind === "job" && entry.status === "running").map((entry) => entry.id),
			...workflows
				.filter((entry) => entry.status === "running" || entry.status === "paused")
				.map((entry) => entry.id),
		];
		if (live.length)
			return {
				...base,
				state: "waiting",
				waitingOn: live,
				reason: "Executor active; wait for a real event, not polling turns",
			};
		const ready = [
			...owned.filter((entry) => entry.review === "awaiting").map((entry) => entry.id),
			...workflows.filter((entry) => entry.status === "awaiting_result").map((entry) => entry.id),
		];
		if (ready.length)
			return {
				...base,
				state: "awaiting_processing",
				waitingOn: ready,
				reason: "Read/process/acknowledge executor results before advancing",
			};
		if (
			owned.some(
				(entry) =>
					entry.dependencies.some((id) => {
						const dependency = this.manager.get(id);
						return dependency.status !== "completed" || dependency.review === "awaiting";
					}) && entry.id === root.id,
			)
		)
			return { ...base, state: "blocked", reason: "Root dependencies are unfinished" };
		if (!root.nextAction)
			return { ...base, state: "blocked", reason: "Unfinished plan has no next-action checkpoint" };
		return { ...base, state: "ready" };
	}

	/** Persist debit before handing one message to the actionable boundary; never an idle timer. */
	reserve(workflows: WorkflowActivity[] | undefined, receipt: string | undefined): string | undefined {
		if (!this.plan || this.plan.state !== "armed") return;
		if (receipt !== this.plan.receipt) {
			this.pause("Active branch has no matching task-specific consent");
			return;
		}
		this.trackWorkflows(workflows);
		const view = this.view(workflows);
		if (view.state !== "ready") {
			if (view.state === "completed") this.persist({ ...this.plan, state: "completed", reason: undefined });
			else if (view.state === "blocked" || view.state === "paused")
				this.persist({ ...this.plan, state: view.state, reason: view.reason });
			return;
		}
		const root = this.manager.get(this.plan.rootId);
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					phase: root.phase,
					nextAction: root.nextAction,
					work: this.manager
						.descendants(root.id)
						.filter((entry) => entry.id !== root.id)
						.map((entry) => [entry.id, entry.status, entry.review]),
					workflows: workflows
						?.filter((entry) => entry.createdAt >= this.plan!.approvedAt)
						.map((entry) => [entry.id, entry.status, entry.outcome]),
				}),
			)
			.digest("hex");
		const stalled = this.plan.lastFingerprint === fingerprint ? this.plan.stalled + 1 : 0;
		if (stalled >= CONTINUITY_LIMITS.maxNoProgress) {
			this.pause("No checkpoint or executor progress after two continuations; inspect rather than loop");
			return;
		}
		this.persist({ ...this.plan, used: this.plan.used + 1, stalled, lastFingerprint: fingerprint });
		return `Task continuation under explicit task-specific opt-in, not a new request or permission grant. Continue only the existing approved scope. Preserve tool approvals, budgets and write restrictions. Do not replay failed/stopped/unknown work. Handle new user input first; pause this plan before acting on a stop request, changed scope, unrelated new work or new permission requirement. Ordinary questions do not extend or renew this authorization. After processing a failure, record resolved_failures and a different corrective next_action; an acknowledgement alone is not a correction. Record phase, summary and next_action through tasks.update; if blocked, record blocked_reason. A prose completion is not task completion.\n${JSON.stringify({ taskId: root.id, scope: this.plan.scope, phase: root.phase, summary: root.summary, nextAction: root.nextAction, continuation: this.plan.used, limit: this.plan.limit })}`;
	}
}

/** Legacy/manual running means bookkeeping unless there is a current owned job. */
export function taskDisplayState(record: TaskRecord, all: TaskRecord[]): string {
	if (record.kind === "job") return `job:${record.status}`;
	if (record.blockedReason) return "task:blocked";
	const descendants = new Set([record.id]);
	for (let pass = 0; pass < all.length; pass++) {
		const before = descendants.size;
		for (const entry of all) if (entry.parentTaskId && descendants.has(entry.parentTaskId)) descendants.add(entry.id);
		if (before === descendants.size) break;
	}
	if (
		all.some(
			(entry) =>
				entry.kind === "job" &&
				entry.status === "running" &&
				(descendants.has(entry.id) || (entry.taskId && descendants.has(entry.taskId))),
		)
	)
		return "task:waiting-job";
	return record.status === "running" ? "task:needs-continuation" : `task:${record.status}`;
}

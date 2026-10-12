import type { Usage } from "@earendil-works/pi-ai";
import { addUsage, emptyUsage, type UsageObservation } from "./types.ts";

export type BudgetScope = "workflow" | "agent" | "phase";
export type RequestBudgetStatus = "reserved" | "dispatched" | "unknown" | "settled" | "released";

export interface RequestBudgetEstimate {
	id: string;
	agentId: string;
	phaseId: string;
	estimatedInputTokens: number;
	maxOutputTokens: number;
	marginTokens: number;
}
export interface RequestBudgetRecord extends RequestBudgetEstimate {
	reservedTokens: number;
	status: RequestBudgetStatus;
	usage?: Usage;
	underestimatedTokens?: number;
}
export interface BudgetTotals {
	limit: number;
	usage: Usage;
	reservedTokens: number;
	/** Subset of reservedTokens, not an additional debit. */
	unknownTokens: number;
	availableTokens: number;
	overspentTokens: number;
	/** Reported actual plus all outstanding estimates beyond the limit; old history may omit it. */
	overcommittedTokens?: number;
}
export interface WorkflowBudgetSnapshot extends BudgetTotals {
	agents: Array<BudgetTotals & { id: string }>;
	phases: Array<BudgetTotals & { id: string }>;
	requests: RequestBudgetRecord[];
}
export interface BudgetSettlement {
	applied: boolean;
	unknown: boolean;
	exceeded: BudgetScope[];
}

/** Admission failure never reserves anything or changes an existing request. */
export class BudgetAdmissionError extends Error {
	readonly scope: BudgetScope;
	readonly scopeId: string;
	readonly requestedTokens: number;
	readonly availableTokens: number;

	constructor(scope: BudgetScope, scopeId: string, requestedTokens: number, availableTokens: number) {
		super(`Workflow ${scope} budget cannot reserve ${requestedTokens} tokens; ${availableTokens} available`);
		this.name = "BudgetAdmissionError";
		this.scope = scope;
		this.scopeId = scopeId;
		this.requestedTokens = requestedTokens;
		this.availableTokens = availableTokens;
	}
}

function tokenCount(value: number, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw new Error(`${label} must be a safe integer >= ${minimum}`);
	return value;
}

function identifier(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error("Invalid budget identifier");
	return value;
}

/** Normalize reported usage without trusting a total smaller than its component counts. */
export function normalizeWorkflowUsage(source: Usage): Usage {
	const usage = emptyUsage();
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		usage[key] = tokenCount(source[key], `usage.${key}`);
	const components = tokenCount(usage.input + usage.output + usage.cacheRead + usage.cacheWrite, "usage components");
	usage.totalTokens = Math.max(usage.totalTokens, components);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		const cost = source.cost[key];
		if (!Number.isFinite(cost) || cost < 0) throw new Error(`usage.cost.${key} must be finite and non-negative`);
		usage.cost[key] = cost;
	}
	return usage;
}

/**
 * Synchronous request accounting. Reserve only after asynchronous gates have passed;
 * reserve() contains no await, so competing callbacks cannot spend the same balance.
 * Estimates are admission safeguards, not a hard billing guarantee. Cache reads count.
 * Sent requests without trustworthy usage retain their reservation until late usage arrives.
 * This ledger authorizes neither a request, a retry, nor a resumed runtime.
 */
export class WorkflowBudgetLedger {
	private readonly limit: number;
	private readonly maxRequests: number;
	private readonly records = new Map<string, RequestBudgetRecord>();
	private readonly agentLimits = new Map<string, number>();
	private readonly phaseLimits = new Map<string, number>();

	constructor(limit: number, maxRequests = 2048) {
		this.limit = tokenCount(limit, "Workflow budget", 1);
		this.maxRequests = tokenCount(maxRequests, "Request record limit", 1);
		if (limit > 2000000 || maxRequests > 8192) throw new Error("Workflow budget ledger limit exceeded");
	}

	/** Define a scope once, before its first reservation; never raise the workflow limit. */
	defineScope(scope: "agent" | "phase", id: string, limit: number): void {
		if (scope !== "agent" && scope !== "phase") throw new Error("Invalid budget scope");
		identifier(id);
		tokenCount(limit, `${scope} budget`, 1);
		if (limit > this.limit) throw new Error("Scope budget exceeds workflow limit");
		const limits = scope === "agent" ? this.agentLimits : this.phaseLimits;
		if (limits.has(id) || [...this.records.values()].some((record) => record[`${scope}Id`] === id))
			throw new Error("Budget scope already defined or used");
		if (limits.size >= this.maxRequests) throw new Error("Budget scope record limit reached");
		limits.set(id, limit);
	}

	private totals(scope: BudgetScope = "workflow", id = "", replacement?: RequestBudgetRecord): BudgetTotals {
		const usage = emptyUsage();
		let reservedTokens = 0;
		let unknownTokens = 0;
		for (const original of this.records.values()) {
			const record = original.id === replacement?.id ? replacement : original;
			if (scope !== "workflow" && record[`${scope}Id`] !== id) continue;
			if (record.status === "settled" && record.usage) addUsage(usage, record.usage);
			else if (record.status !== "released") {
				reservedTokens += record.reservedTokens;
				if (record.status === "unknown") unknownTokens += record.reservedTokens;
			}
		}
		tokenCount(usage.totalTokens + reservedTokens, "Cumulative budget");
		for (const cost of Object.values(usage.cost))
			if (!Number.isFinite(cost)) throw new Error("Cumulative usage cost overflow");
		const limit =
			scope === "workflow"
				? this.limit
				: ((scope === "agent" ? this.agentLimits : this.phaseLimits).get(id) ?? this.limit);
		return {
			limit,
			usage,
			reservedTokens,
			unknownTokens,
			availableTokens: Math.max(0, limit - usage.totalTokens - reservedTokens),
			overspentTokens: Math.max(0, usage.totalTokens - limit),
			overcommittedTokens: Math.max(0, usage.totalTokens + reservedTokens - limit),
		};
	}

	reserve(estimate: RequestBudgetEstimate): RequestBudgetRecord {
		identifier(estimate.id);
		identifier(estimate.agentId);
		identifier(estimate.phaseId);
		if (this.records.has(estimate.id))
			throw new Error("Budget request ID already used; retries need a new admission");
		if (this.records.size >= this.maxRequests) throw new Error("Request budget record limit reached");
		const reservedTokens = tokenCount(
			tokenCount(estimate.estimatedInputTokens, "Estimated input") +
				tokenCount(estimate.maxOutputTokens, "Output limit", 1) +
				tokenCount(estimate.marginTokens, "Input margin"),
			"Reservation",
			1,
		);
		for (const [scope, id] of [
			["workflow", ""],
			["agent", estimate.agentId],
			["phase", estimate.phaseId],
		] as const) {
			const { availableTokens } = this.totals(scope, id);
			if (reservedTokens > availableTokens)
				throw new BudgetAdmissionError(scope, id, reservedTokens, availableTokens);
		}
		const record: RequestBudgetRecord = {
			id: estimate.id,
			agentId: estimate.agentId,
			phaseId: estimate.phaseId,
			estimatedInputTokens: estimate.estimatedInputTokens,
			maxOutputTokens: estimate.maxOutputTokens,
			marginTokens: estimate.marginTokens,
			reservedTokens,
			status: "reserved",
		};
		this.records.set(record.id, record);
		return structuredClone(record);
	}

	private get(id: string): RequestBudgetRecord {
		const record = this.records.get(id);
		if (!record) throw new Error("Unknown budget request");
		return record;
	}

	/** Mark conservatively before handing a request to a provider that may dispatch it. */
	markDispatched(id: string): void {
		const record = this.get(id);
		if (record.status === "dispatched") return;
		if (record.status !== "reserved") throw new Error("Cannot dispatch a terminated or unknown budget request");
		record.status = "dispatched";
	}

	releaseUnsent(id: string): boolean {
		const record = this.get(id);
		if (record.status === "released") return false;
		if (record.status !== "reserved") throw new Error("Cannot refund a potentially dispatched request");
		record.status = "released";
		return true;
	}

	markUnknown(id: string): boolean {
		const record = this.get(id);
		if (record.status === "unknown") return false;
		if (record.status !== "dispatched") throw new Error("Only a dispatched request can have unknown usage");
		record.status = "unknown";
		return true;
	}

	settle(id: string, source: Usage, observation?: UsageObservation): BudgetSettlement {
		const record = this.get(id);
		const usage = normalizeWorkflowUsage(source);
		if (record.status === "settled") {
			if (JSON.stringify(record.usage) !== JSON.stringify(usage))
				throw new Error("Conflicting usage for settled request");
			return { applied: false, unknown: false, exceeded: [] };
		}
		if (record.status !== "dispatched" && record.status !== "unknown")
			throw new Error("Cannot settle an undispatched request");
		if (!(observation?.reported ?? usage.totalTokens > 0)) {
			this.markUnknown(id);
			return { applied: false, unknown: true, exceeded: [] };
		}
		const replacement: RequestBudgetRecord = {
			...record,
			status: "settled",
			usage,
			underestimatedTokens: Math.max(0, usage.totalTokens - record.reservedTokens),
		};
		const exceeded: BudgetScope[] = [];
		for (const [scope, scopeId] of [
			["workflow", ""],
			["agent", record.agentId],
			["phase", record.phaseId],
		] as const) {
			const total = this.totals(scope, scopeId, replacement);
			if (total.usage.totalTokens >= total.limit) exceeded.push(scope);
		}
		// Validate every derived total before mutating; never lose the old debit on bad usage.
		this.records.set(id, replacement);
		return { applied: true, unknown: false, exceeded };
	}

	snapshot(): WorkflowBudgetSnapshot {
		const records = [...this.records.values()];
		const agents = new Set([...this.agentLimits.keys(), ...records.map((record) => record.agentId)]);
		const phases = new Set([...this.phaseLimits.keys(), ...records.map((record) => record.phaseId)]);
		return {
			...this.totals(),
			agents: [...agents].map((id) => ({ id, ...this.totals("agent", id) })),
			phases: [...phases].map((id) => ({ id, ...this.totals("phase", id) })),
			requests: structuredClone(records),
		};
	}
}

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import type { ChildResourceSnapshot, ChildRole } from "./child-resources.ts";
import { assertChildCwd, assertChildRole } from "./child-resources.ts";

export interface ChildScopeIdentity {
	readonly id: string;
	readonly cwd: string;
	readonly role: ChildRole;
	readonly epoch: string;
	readonly backendId: string;
}

export interface ChildToolHostState {
	cwd: string;
	epoch: string;
	backendId: string;
	projectTrusted: boolean;
	toolNames: readonly string[];
}

export interface ChildToolInvocation {
	readonly scope: Readonly<ChildScopeIdentity>;
	readonly id: string;
	readonly callerToolCallId: string;
	readonly toolName: string;
	readonly args: Readonly<Record<string, unknown>>;
	/** Combines child lifetime and per-call cancellation; never the parent's launch-turn signal. */
	readonly signal: AbortSignal;
}

export type ChildToolDecision = { allow: true } | { allow: false; reason?: string };

/**
 * Trusted host adapter. This is not an extension/model-supplied permission object.
 * Tools must already be bound to the stated cwd/backend, including any sandbox operations.
 * No implementation is synthesized when an adapter, capability or backend is unavailable.
 */
export interface ChildToolScopeHost {
	readonly tools: readonly AgentTool[];
	getState(): ChildToolHostState;
	/** Synchronous live check (including protected paths), immediately before dispatch. */
	checkCall(call: ChildToolInvocation): boolean;
	/** Shared deny/approval pipeline. Missing decisions, errors and unavailable approvals deny. */
	authorize(call: ChildToolInvocation): Promise<ChildToolDecision>;
	/** Shared result/redaction pipeline. Raw results and partial updates never bypass this. */
	filterResult(call: ChildToolInvocation, result: AgentToolResult<unknown>): Promise<AgentToolResult<unknown>>;
}

export interface ChildToolScopeOptions {
	identity: ChildScopeIdentity;
	resources: ChildResourceSnapshot;
	/** Independent child/workflow lifetime, not the signal of the launching parent tool. */
	signal: AbortSignal;
	allowWrites: boolean;
	writeAccess: boolean;
	host: ChildToolScopeHost;
}

export interface ChildToolRecord {
	id: string;
	callerToolCallId: string;
	toolName: string;
	state: "queued" | "authorizing" | "running" | "completed" | "failed" | "denied" | "unknown";
	dispatched: boolean;
	delivery: "pending" | "delivered" | "failed";
	/** A failure or cancellation after dispatch is not evidence that a mutation rolled back. */
	effects: "not_started" | "read_only" | "reported_completed" | "unknown";
}

export const CHILD_TOOL_SCOPE_LIMITS = Object.freeze({ maxCalls: 1024, maxPending: 16, maxRecords: 64 });
const readTools = new Set(["read", "grep", "find", "ls"]);
const writeTools = new Set(["edit", "write"]);

function immutableArgs(args: Record<string, unknown>): Readonly<Record<string, unknown>> {
	// Tool inputs are JSON. A policy must not retain a mutable reference and change the
	// approved target while its asynchronous decision is queued or after it has returned.
	const copied: unknown = JSON.parse(JSON.stringify(args));
	const freeze = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	};
	freeze(copied);
	return copied as Readonly<Record<string, unknown>>;
}

/**
 * Detached, serial tool scope with its own records and drain. It is not a session,
 * resource loader, OS sandbox, rollback mechanism or authorization to resume work.
 * The host must bump epoch for resource/trust/session/backend replacement and for
 * policy changes that cannot be checked synchronously by getState/checkCall.
 */
export class ChildToolScope {
	readonly identity: Readonly<ChildScopeIdentity>;
	readonly resources: ChildResourceSnapshot;
	readonly tools: readonly AgentTool[];
	private readonly host: ChildToolScopeHost;
	private readonly controller = new AbortController();
	private readonly sourceSignal: AbortSignal;
	private readonly sourceAbort: () => void;
	private readonly grants = new Map<string, AgentTool>();
	private readonly remaining = new Set<string>();
	private readonly usedIds = new Set<string>();
	private readonly records: ChildToolRecord[] = [];
	private droppedRecords = 0;
	private pending = 0;
	private sequence = 0;
	private closed = false;
	private queueTail: Promise<void> = Promise.resolve();

	constructor(options: ChildToolScopeOptions) {
		const { identity, resources, host } = options;
		assertChildCwd(identity.cwd);
		assertChildRole(identity.role);
		if (
			typeof identity.id !== "string" ||
			typeof identity.epoch !== "string" ||
			typeof identity.backendId !== "string" ||
			!identity.id ||
			identity.id.length > 256 ||
			!identity.epoch ||
			!identity.backendId ||
			identity.epoch.length > 256 ||
			identity.backendId.length > 256 ||
			resources.cwd !== identity.cwd ||
			resources.epoch !== identity.epoch ||
			resources.role !== identity.role
		)
			throw new Error("Child tool/resource scope mismatch");
		if (
			!host ||
			[host.getState, host.checkCall, host.authorize, host.filterResult].some((fn) => typeof fn !== "function")
		) {
			throw new Error("Child tools require a complete host policy adapter");
		}
		this.identity = Object.freeze({
			id: identity.id,
			cwd: identity.cwd,
			role: identity.role,
			epoch: identity.epoch,
			backendId: identity.backendId,
		});
		this.resources = resources;
		this.host = host;
		this.sourceSignal = options.signal;
		const state = this.currentState();
		const writes = identity.role === "worker" && options.allowWrites === true && options.writeAccess === true;
		for (const tool of host.tools) {
			if (!readTools.has(tool.name) && !(writes && writeTools.has(tool.name))) continue;
			if (!state.toolNames.includes(tool.name)) continue;
			if (this.grants.has(tool.name)) throw new Error("Duplicate child tool grant");
			this.grants.set(tool.name, { ...tool });
			this.remaining.add(tool.name);
		}
		this.tools = Object.freeze(
			[...this.grants.values()].map((tool) =>
				Object.freeze({
					...tool,
					// Preparation and validation belong inside this scope, once, before authorization.
					prepareArguments: undefined,
					execute: (id: string, args: unknown, signal?: AbortSignal) => this.execute(id, tool.name, args, signal),
				}),
			),
		);
		this.sourceAbort = () => {
			void this.close();
		};
		this.sourceSignal.addEventListener("abort", this.sourceAbort, { once: true });
		if (this.sourceSignal.aborted) void this.close();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	private currentState(): ChildToolHostState {
		try {
			const state = this.host.getState();
			if (
				state.cwd === this.identity.cwd &&
				state.epoch === this.identity.epoch &&
				state.backendId === this.identity.backendId &&
				typeof state.projectTrusted === "boolean" &&
				Array.isArray(state.toolNames) &&
				(!this.resources.projectTrusted || state.projectTrusted)
			)
				return state;
		} catch {
			// Host exceptions may contain secrets, even before a tool reaches authorization.
		}
		throw new Error("Child host scope is stale or unsupported");
	}

	/** Also call before model requests: a tool-less child must not reuse stale resources. */
	assertActive(): void {
		if (this.closed) throw new Error("Child scope is closed");
		this.signal.throwIfAborted();
		try {
			const state = this.currentState();
			for (const name of this.remaining) if (!state.toolNames.includes(name)) this.remaining.delete(name);
		} catch (error) {
			void this.close();
			throw error;
		}
	}

	private check(call: ChildToolInvocation): void {
		this.assertActive();
		call.signal.throwIfAborted();
		if (!this.remaining.has(call.toolName) || this.host.checkCall(call) !== true) {
			throw new Error("Child tool is not authorized by the current host policy");
		}
		// A synchronous host callback can itself cancel or revoke the grant.
		this.assertActive();
		call.signal.throwIfAborted();
		if (!this.remaining.has(call.toolName)) throw new Error("Child tool grant was revoked");
	}

	/** Internal tool failures reject; a plain Agent converts them into error tool results. */
	execute(
		callerToolCallId: string,
		toolName: string,
		args: unknown,
		callerSignal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		try {
			this.assertActive();
			if (!callerToolCallId || callerToolCallId.length > 256 || this.usedIds.has(callerToolCallId)) {
				throw new Error("Invalid or repeated child tool call ID");
			}
			if (this.sequence >= CHILD_TOOL_SCOPE_LIMITS.maxCalls || this.pending >= CHILD_TOOL_SCOPE_LIMITS.maxPending) {
				throw new Error("Child tool call limit exceeded");
			}
			if (!this.grants.has(toolName)) throw new Error("Tool is outside the captured child capability ceiling");
		} catch (error) {
			return Promise.reject(error);
		}
		this.usedIds.add(callerToolCallId);
		const record: ChildToolRecord = {
			id: `${this.identity.id}/${++this.sequence}`,
			callerToolCallId,
			toolName,
			state: "queued",
			dispatched: false,
			delivery: "pending",
			effects: "not_started",
		};
		this.records.push(record);
		if (this.records.length > CHILD_TOOL_SCOPE_LIMITS.maxRecords) {
			this.records.shift();
			this.droppedRecords++;
		}
		this.pending++;
		// Snapshot caller-owned arguments before waiting on another call or an approval.
		let input: unknown;
		try {
			input = structuredClone(args);
		} catch {
			record.state = "denied";
			record.delivery = "failed";
			this.pending--;
			return Promise.reject(new Error("Invalid child tool arguments"));
		}
		const signal = callerSignal ? AbortSignal.any([this.signal, callerSignal]) : this.signal;
		const work = this.queueTail.then(() => this.run(record, input, signal));
		this.queueTail = work
			.then(
				() => {},
				() => {},
			)
			.finally(() => {
				this.pending--;
			});
		return work;
	}

	private async run(record: ChildToolRecord, input: unknown, signal: AbortSignal): Promise<AgentToolResult<unknown>> {
		try {
			this.assertActive();
			signal.throwIfAborted();
			const tool = this.grants.get(record.toolName)!;
			const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
			const args = immutableArgs(
				validateToolArguments(tool, {
					type: "toolCall",
					id: record.id,
					name: record.toolName,
					arguments: prepared as JsonObject,
				}),
			);
			const call: ChildToolInvocation = Object.freeze({
				scope: this.identity,
				id: record.id,
				callerToolCallId: record.callerToolCallId,
				toolName: record.toolName,
				args,
				signal,
			});
			this.check(call);
			record.state = "authorizing";
			let decision: ChildToolDecision;
			try {
				decision = await this.host.authorize(call);
			} catch {
				throw new Error("Child tool authorization failed or approval unavailable");
			}
			if (decision?.allow !== true) throw new Error("Child tool authorization denied");
			// No await between the final live check and dispatch. A queued approval is not a lease.
			this.check(call);
			record.state = "running";
			record.dispatched = true;
			record.effects = writeTools.has(record.toolName) ? "unknown" : "read_only";
			const result = await tool.execute(record.id, structuredClone(args), signal);
			if (!signal.aborted) {
				record.state = result.isError === true ? "failed" : "completed";
				if (writeTools.has(record.toolName) && result.isError !== true) record.effects = "reported_completed";
			}
			// Do not deliver raw results if permission changed while the backend was running.
			this.check(call);
			let filtered: AgentToolResult<unknown>;
			try {
				filtered = await this.host.filterResult(call, result);
			} catch {
				throw new Error("Child tool result policy failed");
			}
			this.check(call);
			if (!filtered || !Array.isArray(filtered.content)) throw new Error("Invalid child result policy response");
			record.delivery = "delivered";
			return filtered;
		} catch {
			record.delivery = "failed";
			if (!record.dispatched) record.state = "denied";
			else if (signal.aborted && (record.state === "running" || record.state === "unknown"))
				record.state = "unknown";
			else if (record.state === "running") record.state = "failed";
			// Do not disclose arbitrary exception text from a backend or policy to the child.
			// Do not attach the original cause/properties: consumers may recursively render them.
			throw new Error(record.dispatched ? "Child tool execution or result delivery failed" : "Child tool denied");
		}
	}

	snapshot(): { calls: ChildToolRecord[]; droppedRecords: number; pending: number; closed: boolean } {
		return {
			calls: this.records.map((record) => ({ ...record })),
			droppedRecords: this.droppedRecords,
			pending: this.pending,
			closed: this.closed,
		};
	}

	/**
	 * Prevent new calls and signal owned work immediately. Drain waits for actual settlement;
	 * an uncooperative host operation can delay it. Cancellation does not prove rollback.
	 */
	close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.sourceSignal.removeEventListener("abort", this.sourceAbort);
			this.controller.abort();
			for (const record of this.records) {
				if (record.state === "running") record.state = "unknown";
				else if (record.state === "queued" || record.state === "authorizing") record.state = "denied";
			}
		}
		return this.queueTail;
	}
}

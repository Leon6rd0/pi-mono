import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { safeText } from "../task-monitor/manager.ts";
import {
	createTextArchiveWriter,
	inspectTextArchive,
	normalizeTextArchives,
	type TextArchiveView,
} from "./artifacts.ts";
import { BudgetAdmissionError, normalizeWorkflowUsage, WorkflowBudgetLedger } from "./budget.ts";
import { clampWorkflowThinkingLevel } from "./effort.ts";
import { controlSchema, progressSchema, recordSchema, requestEstimateSchema } from "./records.ts";
import { prelude } from "./script.ts";
import {
	type AgentRecord,
	agentSchema,
	type ChildRunner,
	defaultLimits,
	emptyUsage,
	type ModelRequestEstimate,
	type ModelRequestRecord,
	type ScriptRunner,
	type WorkflowLimits,
	type WorkflowRecord,
} from "./types.ts";

interface Runtime {
	controller: AbortController;
	budget: WorkflowBudgetLedger;
	done: Promise<void>;
	wake: Set<() => void>;
	children: Set<Promise<unknown>>;
	active: number;
	logBytes: number;
	archive: ReturnType<typeof createTextArchiveWriter>;
	failure?: { outcome: "stopped" | "failed"; message: string };
}
export interface WorkflowManagerOptions {
	storageRoot: string;
	sessionId: string;
	allowedCwdRoots?: string[];
	limits?: Partial<WorkflowLimits>;
	onChange?: () => void;
	onReady?: (record: WorkflowRecord) => void;
}
export interface StartWorkflow {
	label: string;
	cwd: string;
	code: string;
	args?: JsonValue;
	writeAccess?: boolean;
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	context: ExtensionToolContext;
	runChild: ChildRunner;
	runScript: ScriptRunner;
}

/** Independent Workflow registry. No Ultra entry points, commands, prompts, extensions or global state. */
export class WorkflowManager {
	private readonly directory: string;
	private readonly options: WorkflowManagerOptions;
	private readonly limits: WorkflowLimits;
	private readonly records = new Map<string, WorkflowRecord>();
	private readonly running = new Map<string, Runtime>();
	private closing = false;
	private closed?: Promise<void>;

	constructor(options: WorkflowManagerOptions) {
		this.options = options;
		this.limits = { ...defaultLimits, ...options.limits };
		for (const [key, maximum] of Object.entries({
			concurrency: 4,
			maxAgents: 32,
			maxTurns: 64,
			maxOutputTokens: 16384,
			maxTotalTokens: 2000000,
			timeoutSeconds: 86400,
		})) {
			const value = this.limits[key as keyof WorkflowLimits];
			if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be 1–${maximum}`);
		}
		if (!isAbsolute(options.storageRoot) || options.allowedCwdRoots?.some((path) => !isAbsolute(path)))
			throw new Error("Workflow paths must be absolute");
		this.directory = join(options.storageRoot, createHash("sha256").update(options.sessionId).digest("hex"));
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(this.directory)
			.filter((name) => /^workflow-[a-f0-9-]{36}\.json$/.test(name))
			.slice(0, 256)) {
			try {
				const path = join(this.directory, name);
				if (statSync(path).size > 8 * 1024 * 1024) continue;
				const record: unknown = JSON.parse(readFileSync(path, "utf8"));
				normalizeTextArchives(record);
				if (!Check(recordSchema, record) || `${record.id}.json` !== name) continue;
				if (record.status === "running" || record.status === "paused") {
					record.status = "awaiting_result";
					record.outcome = "unknown";
					record.error =
						"Previous runtime ended without a confirmed result. Nothing is automatically resumed or restarted.";
					if (record.budget) {
						for (const request of record.budget.requests)
							if (request.status === "reserved" || request.status === "dispatched") request.status = "unknown";
						const unknown = record.budget.requests.filter((request) => request.status === "unknown");
						record.budget.unknownTokens = unknown.reduce((sum, request) => sum + request.reservedTokens, 0);
						for (const scope of record.budget.agents)
							scope.unknownTokens = unknown
								.filter((request) => request.agentId === scope.id)
								.reduce((sum, request) => sum + request.reservedTokens, 0);
						for (const scope of record.budget.phases)
							scope.unknownTokens = unknown
								.filter((request) => request.phaseId === scope.id)
								.reduce((sum, request) => sum + request.reservedTokens, 0);
					}
					for (const agent of record.agents) {
						if (agent.budget)
							agent.budget.unknownTokens =
								record.budget?.agents.find((scope) => scope.id === agent.id)?.unknownTokens ??
								agent.budget.reservedTokens;
						for (const operation of agent.progress?.operations ?? [])
							if (operation.status === "started") operation.status = "unknown";
						for (const request of agent.requests ?? [])
							if (request.status === "in_flight") request.status = "unknown";
						if (agent.status === "running" || agent.status === "queued") {
							agent.status = "stopped";
							agent.error = "Previous runtime; result unknown";
						}
					}
				}
				this.records.set(record.id, record);
			} catch {
				/* Corrupt history must not prevent access to other workflows. */
			}
		}
	}

	list(includeArchived = false): WorkflowRecord[] {
		return [...this.records.values()]
			.filter((record) => includeArchived || record.status !== "archived")
			.map((record) => structuredClone(record));
	}
	private requireRecord(id: string): WorkflowRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown workflow: ${id}`);
		return record;
	}
	get(id: string): WorkflowRecord {
		return structuredClone(this.requireRecord(id));
	}
	/** File checks are explicit queries, never part of get/list, UI refresh or execution state. */
	archives(id: string, agentId?: string): Array<TextArchiveView & { ownerId: string }> {
		const record = this.requireRecord(id);
		const views: Array<TextArchiveView & { ownerId: string }> = [];
		if (!agentId && record.resultArchive)
			views.push({ ownerId: record.id, ...inspectTextArchive(this.directory, id, "script", record.resultArchive) });
		for (const agent of record.agents) {
			if (!agent.outputArchive || (agentId && agent.id !== agentId)) continue;
			const slot = agent.id.startsWith(`${id}/agent-`) ? agent.id.slice(id.length + 1) : "";
			views.push({ ownerId: agent.id, ...inspectTextArchive(this.directory, id, slot, agent.outputArchive) });
		}
		return views;
	}
	logPath(id: string): string {
		if (!/^workflow-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid workflow ID");
		return join(this.directory, `${id}.log`);
	}
	recordPath(id: string): string {
		return this.logPath(id).replace(/\.log$/, ".json");
	}
	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* UI cannot change execution outcomes. */
		}
	}
	private save(record: WorkflowRecord, changes: Partial<WorkflowRecord> = {}): void {
		const saved = { ...record, ...changes, updatedAt: Date.now() };
		const path = join(this.directory, `${record.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
		renameSync(temporary, path);
		// Commit pending fields only after persistence, without replacing late callbacks' owner.
		Object.assign(record, saved);
		this.records.set(record.id, record);
		this.changed();
	}
	private log(record: WorkflowRecord, runtime: Runtime, message: string): void {
		const text = `${new Date().toISOString()} ${safeText(message).slice(0, 2000)}\n`;
		const size = Buffer.byteLength(text);
		if (runtime.logBytes + size > 2 * 1024 * 1024) throw new Error("Workflow log limit reached (2 MiB)");
		appendFileSync(this.logPath(record.id), text);
		runtime.logBytes += size;
	}
	private wake(runtime: Runtime): void {
		for (const resolve of [...runtime.wake]) resolve();
	}
	private wait(runtime: Runtime, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				runtime.wake.delete(done);
				signal.removeEventListener("abort", aborted);
			};
			const done = () => {
				cleanup();
				resolve();
			};
			const aborted = () => {
				cleanup();
				reject(signal.reason ?? new Error("Workflow aborted"));
			};
			runtime.wake.add(done);
			signal.addEventListener("abort", aborted, { once: true });
		});
	}
	private async gate(record: WorkflowRecord, runtime: Runtime, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		while (record.status === "paused") await this.wait(runtime, signal);
		signal.throwIfAborted();
	}

	private syncBudget(record: WorkflowRecord, runtime: Runtime): void {
		const snapshot = runtime.budget.snapshot();
		record.budget = snapshot;
		record.usage = structuredClone(snapshot.usage);
		for (const agent of record.agents) {
			const scope = snapshot.agents.find((scope) => scope.id === agent.id);
			if (scope) {
				const { id: _id, ...totals } = scope;
				agent.budget = totals;
				agent.usage = structuredClone(scope.usage);
			}
		}
	}

	private async admitRequest(
		record: WorkflowRecord,
		runtime: Runtime,
		agent: AgentRecord,
		estimate: ModelRequestEstimate,
		signal: AbortSignal,
	): Promise<ModelRequestRecord> {
		if (!Check(requestEstimateSchema, estimate) || estimate.maxOutputTokens > this.limits.maxOutputTokens)
			throw new Error("Child request requires a valid bounded estimate before admission");
		const requests = agent.requests!;
		if (requests.some((request) => request.status === "in_flight"))
			throw new Error("Overlapping child model requests are unsupported");
		if (requests.length >= this.limits.maxTurns) throw new Error("Child request accounting limit reached");
		const id = `${agent.id}/request-${requests.length + 1}`;
		while (true) {
			await this.gate(record, runtime, signal);
			// The await above may yield to pause/stop/settlement: recheck before atomic reservation.
			signal.throwIfAborted();
			if (record.status === "paused") continue;
			try {
				const reservation = runtime.budget.reserve({
					id,
					agentId: agent.id,
					phaseId: agent.phaseId!,
					estimatedInputTokens: estimate.estimatedInputTokens,
					maxOutputTokens: estimate.maxOutputTokens,
					marginTokens: estimate.marginTokens,
				});
				const request: ModelRequestRecord = {
					id,
					status: "in_flight",
					source: "request_gate",
					startedAt: Date.now(),
					estimate: structuredClone(estimate),
					reservedTokens: reservation.reservedTokens,
				};
				requests.push(request);
				this.syncBudget(record, runtime);
				this.save(record);
				return request;
			} catch (error) {
				if (!(error instanceof BudgetAdmissionError)) throw error;
				const snapshot = runtime.budget.snapshot();
				const scope =
					error.scope === "workflow"
						? snapshot
						: (error.scope === "agent" ? snapshot.agents : snapshot.phases).find(
								(scope) => scope.id === error.scopeId,
							)!;
				const pending = snapshot.requests.some(
					(request) =>
						(request.status === "reserved" || request.status === "dispatched") &&
						(error.scope === "workflow" ||
							(error.scope === "agent" ? request.agentId : request.phaseId) === error.scopeId),
				);
				// Await real settlements only when they could make this request fit; unknown usage never spins/waits forever.
				if (pending && error.requestedTokens <= scope.limit - scope.usage.totalTokens - scope.unknownTokens) {
					await this.wait(runtime, signal);
					continue;
				}
				runtime.failure = {
					outcome: "failed",
					message: `Workflow token budget exhausted at ${error.scope} admission: ${error.message}`,
				};
				try {
					this.syncBudget(record, runtime);
					this.save(record);
				} finally {
					// A storage failure must not leave independently pending children running.
					runtime.controller.abort(new Error(runtime.failure.message));
				}
				throw error;
			}
		}
	}

	start(options: StartWorkflow): WorkflowRecord {
		if (this.closing) throw new Error("Workflow runtime is shutting down");
		if (this.records.size >= 256 || this.running.size >= 2)
			throw new Error("Workflow limit reached (256 records / 2 running)");
		if (!options.label.trim() || options.label.length > 500 || !options.code.trim() || options.code.length > 65536)
			throw new Error("Workflow requires label (1–500) and code (1–65536 characters)");
		if (!isAbsolute(options.cwd)) throw new Error("Workflow requires an explicit absolute cwd");
		const cwd = realpathSync(options.cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("Workflow cwd must be a directory");
		if (
			this.options.allowedCwdRoots &&
			!this.options.allowedCwdRoots.some((root) => {
				const child = relative(realpathSync(root), cwd);
				return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
			})
		)
			throw new Error("Workflow cwd is outside allowed roots");
		const selectedModel = options.context.modelRegistry.find(options.provider, options.model);
		if (!selectedModel || selectedModel.api === "pi-virtual")
			throw new Error("Workflow requires a known physical model");
		const thinkingLevel = clampWorkflowThinkingLevel(
			selectedModel,
			options.thinkingLevel ?? options.context.thinkingLevel ?? "medium",
		);
		const args = JSON.stringify(options.args ?? {});
		if (args.length > 32768) throw new Error("Workflow args exceed 32768 characters");
		const budget = new WorkflowBudgetLedger(this.limits.maxTotalTokens);
		budget.defineScope("phase", "phase-1", this.limits.maxTotalTokens);
		const record: WorkflowRecord = {
			id: `workflow-${randomUUID()}`,
			label: options.label,
			cwd,
			provider: options.provider,
			model: options.model,
			thinkingLevel,
			status: "running",
			phase: "Start",
			phaseId: "phase-1",
			phases: [{ id: "phase-1", title: "Start" }],
			budget: budget.snapshot(),
			agents: [],
			usage: emptyUsage(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		writeFileSync(this.logPath(record.id), "", { flag: "wx", mode: 0o600 });
		writeFileSync(join(this.directory, `${record.id}.js`), options.code, { flag: "wx", mode: 0o600 });
		this.save(record);
		const runtime: Runtime = {
			controller: new AbortController(),
			budget,
			done: Promise.resolve(),
			wake: new Set(),
			children: new Set(),
			active: 0,
			logBytes: 0,
			archive: createTextArchiveWriter(this.directory, record.id),
		};
		this.running.set(record.id, runtime);
		const timer = setTimeout(() => {
			runtime.failure = { outcome: "failed", message: "Workflow deadline expired (includes paused time)" };
			runtime.controller.abort(new Error(runtime.failure.message));
		}, this.limits.timeoutSeconds * 1000);
		const bridges: AgentTool[] = [
			{
				name: "workflow_agent",
				label: "Workflow child",
				description: "Run an isolated child with a fixed role/tool policy. Returns {id, role, output}.",
				parameters: agentSchema,
				outputSchema: Type.Object({}, { additionalProperties: true }),
				execute: async (_id, input: unknown, callSignal) => {
					if (!Check(agentSchema, input)) throw new Error("Invalid agent arguments");
					if (record.agents.length >= this.limits.maxAgents) throw new Error("Workflow agent count limit reached");
					const signal = callSignal
						? AbortSignal.any([callSignal, runtime.controller.signal])
						: runtime.controller.signal;
					signal.throwIfAborted();
					const childThinkingLevel = clampWorkflowThinkingLevel(selectedModel, input.effort ?? thinkingLevel);
					const agent: AgentRecord = {
						id: `${record.id}/agent-${record.agents.length + 1}`,
						role: input.role ?? "worker",
						label: input.label ?? input.role ?? "worker",
						phase: record.phase,
						phaseId: record.phaseId,
						status: "queued",
						turns: 0,
						usage: emptyUsage(),
						requests: [],
						thinkingLevel: childThinkingLevel,
					};
					budget.defineScope("agent", agent.id, input.maxTotalTokens ?? this.limits.maxTotalTokens);
					record.agents.push(agent);
					this.syncBudget(record, runtime);
					this.save(record);
					const requests = agent.requests!;
					const execution = (async () => {
						let acquired = false;
						try {
							while (true) {
								await this.gate(record, runtime, signal);
								signal.throwIfAborted();
								if (record.status === "paused") continue;
								if (runtime.active < this.limits.concurrency) {
									runtime.active++;
									acquired = true;
									break;
								}
								await this.wait(runtime, signal);
							}
							agent.status = "running";
							this.save(record);
							this.log(record, runtime, `Agent started: ${agent.id} ${agent.label}`);
							const result = await options.runChild({
								id: agent.id,
								request: input,
								thinkingLevel: childThinkingLevel,
								cwd,
								writeAccess: options.writeAccess === true,
								maxTurns: this.limits.maxTurns,
								maxOutputTokens: this.limits.maxOutputTokens,
								signal,
								beforeRequest: async (estimate) =>
									(await this.admitRequest(record, runtime, agent, estimate, signal)).id,
								onRequestDispatched: (requestId) => {
									signal.throwIfAborted();
									const request = requests.find((item) => item.id === requestId);
									if (!request || request.status !== "in_flight" || request.dispatchedAt !== undefined)
										throw new Error("Invalid child request dispatch observation");
									budget.markDispatched(requestId);
									request.dispatchedAt = Date.now();
									agent.turns = (agent.turns ?? 0) + 1;
									this.syncBudget(record, runtime);
									this.save(record);
								},
								onProgress: (progress) => {
									if (!Check(progressSchema, progress)) throw new Error("Invalid bounded child checkpoint");
									agent.progress = structuredClone(progress);
									this.save(record);
								},
								onUsage: (source, observation, requestId) => {
									const request = requests.find((item) => item.id === requestId);
									if (!request) throw new Error("Child usage requires an admitted request ID");
									const usage = normalizeWorkflowUsage(source);
									const settlement = budget.settle(request.id, usage, observation);
									request.usage = usage;
									request.reportedAt ??= Date.now();
									request.status = settlement.unknown ? "unknown" : "reported";
									if (!settlement.unknown)
										request.underestimatedTokens = Math.max(0, usage.totalTokens - request.reservedTokens!);
									this.syncBudget(record, runtime);
									try {
										this.save(record); // Retain observations/accounting before cancellation when possible.
									} finally {
										// Persistence errors cannot suppress the already-settled budget guard.
										this.wake(runtime);
										const snapshot = record.budget!;
										if (
											this.running.has(record.id) &&
											((snapshot.overcommittedTokens ?? 0) > 0 ||
												snapshot.agents.some((scope) => (scope.overcommittedTokens ?? 0) > 0) ||
												snapshot.phases.some((scope) => (scope.overcommittedTokens ?? 0) > 0))
										) {
											runtime.failure = {
												outcome: "failed",
												message:
													"Workflow token budget exhausted; reported usage plus outstanding reservations exceeds a scope limit",
											};
											runtime.controller.abort(new Error(runtime.failure.message));
										}
									}
								},
							});
							signal.throwIfAborted();
							agent.status = "completed";
							agent.output = result.output.slice(0, 16384);
							agent.outputOriginalLength = Math.max(result.outputOriginalLength ?? 0, result.output.length);
							agent.outputTruncated =
								result.outputTruncated === true || agent.outputOriginalLength > agent.output.length;
							if (agent.outputTruncated) {
								agent.outputArchive =
									result.output.length > agent.output.length
										? runtime.archive(agent.id.slice(record.id.length + 1), {
												text: result.output,
												format: "child-text",
												sourcePartial:
													result.outputTruncated === true ||
													agent.outputOriginalLength > result.output.length,
											})
										: { state: "unavailable", reason: "source_unavailable" };
							}
							if (!requests.some((request) => request.dispatchedAt !== undefined)) agent.turns = result.turns;
							this.log(record, runtime, `Agent completed: ${agent.id}`);
							const value: JsonValue = {
								id: agent.id,
								role: agent.role,
								output: agent.output,
								outputTruncated: agent.outputTruncated,
								outputOriginalLength: agent.outputOriginalLength,
							};
							return {
								content: [{ type: "text" as const, text: JSON.stringify(value) }],
								details: value,
								structuredContent: value,
							};
						} catch (error) {
							agent.status = signal.aborted ? "stopped" : "failed";
							agent.error = String(error).slice(0, 2000);
							throw error;
						} finally {
							for (const request of requests.filter((item) => item.status === "in_flight")) {
								if (request.dispatchedAt === undefined) {
									budget.releaseUnsent(request.id);
									request.status = "not_sent";
								} else {
									budget.markUnknown(request.id);
									request.status = "unknown";
								}
							}
							for (const operation of agent.progress?.operations ?? [])
								if (operation.status === "started") operation.status = "unknown";
							this.syncBudget(record, runtime);
							if (acquired) runtime.active--;
							this.wake(runtime);
							this.save(record);
						}
					})();
					runtime.children.add(execution);
					try {
						return await execution;
					} finally {
						runtime.children.delete(execution);
					}
				},
			},
			{
				name: "workflow_control",
				label: "Workflow progress",
				description: "Set phase, log progress or wait at a pause checkpoint.",
				parameters: controlSchema,
				execute: async (_id, input: unknown, callSignal) => {
					if (!Check(controlSchema, input)) throw new Error("Invalid workflow control arguments");
					const signal = callSignal
						? AbortSignal.any([callSignal, runtime.controller.signal])
						: runtime.controller.signal;
					await this.gate(record, runtime, signal);
					if (input.action !== "checkpoint") {
						if (!input.text?.trim()) throw new Error("phase/log requires text");
						if (input.action === "phase") {
							if (record.phases!.length >= 1024) throw new Error("Workflow phase record limit reached");
							const phaseId = `phase-${record.phases!.length + 1}`;
							budget.defineScope("phase", phaseId, input.maxTotalTokens ?? this.limits.maxTotalTokens);
							record.phase = input.text;
							record.phaseId = phaseId;
							record.phases!.push({ id: phaseId, title: input.text });
							this.syncBudget(record, runtime);
							this.save(record);
						} else if (input.maxTotalTokens !== undefined)
							throw new Error("Only phases accept a token allocation");
						this.log(record, runtime, `${input.action}: ${input.text}`);
					}
					return { content: [{ type: "text", text: "ok" }], details: undefined };
				},
			},
		];
		let callNumber = 0;
		const context: ExtensionToolContext = {
			...options.context,
			cwd,
			signal: runtime.controller.signal,
			tools: bridges,
			executeTool: async (name, input, execOptions = {}) => {
				const toolCall = {
					type: "toolCall" as const,
					id: `${record.id}/bridge-${++callNumber}`,
					name,
					arguments: {},
				};
				try {
					if (callNumber > 1024) {
						runtime.failure = { outcome: "failed", message: "Workflow bridge call limit reached (1024)" };
						runtime.controller.abort(new Error(runtime.failure.message));
						throw new Error(runtime.failure.message);
					}
					const tool = bridges.find((tool) => tool.name === name);
					if (!tool || !Check(tool.parameters, input))
						throw new Error("Unknown workflow capability or invalid arguments");
					const result = await tool.execute(toolCall.id, input, execOptions.signal ?? runtime.controller.signal);
					return { toolCall, result, isError: result.isError ?? false };
				} catch (error) {
					return {
						toolCall,
						result: { content: [{ type: "text", text: String(error) }], details: undefined },
						isError: true,
					};
				}
			},
		};
		// Work belongs to this manager, never to the launching turn's signal or tool batch.
		runtime.done = Promise.resolve()
			.then(async () => {
				try {
					const result = await options.runScript(
						`${prelude}\nconst args = JSON.parse(${JSON.stringify(args)});\n${options.code}`,
						context,
						runtime.controller.signal,
					);
					const text = result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					record.result = text.slice(0, 65536);
					record.resultOriginalLength = result.outputTruncated ? undefined : text.length;
					record.resultTruncated = result.outputTruncated === true || text.length > 65536;
					record.outcome = result.isError ? "failed" : "completed";
					if (record.resultTruncated) {
						record.resultArchive =
							result.fullOutputPath !== undefined
								? runtime.archive("script", { spillPath: result.fullOutputPath })
								: text.length > record.result.length
									? runtime.archive("script", {
											text,
											format: "script-content",
											sourcePartial: result.outputTruncated === true,
										})
									: { state: "unavailable", reason: "source_unavailable" };
					}
				} catch (error) {
					record.outcome = "failed";
					record.error = String(error).slice(0, 2000);
				} finally {
					// Cancel and drain unawaited host calls before publishing a ready result.
					runtime.controller.abort();
					await Promise.allSettled([...runtime.children]);
					clearTimeout(timer);
					if (runtime.failure) {
						record.outcome = runtime.failure.outcome;
						record.error = runtime.failure.message;
					}
					record.deliveryComplete =
						record.outcome === "completed" &&
						!record.resultTruncated &&
						record.agents.every((agent) => agent.status === "completed" && !agent.outputTruncated);
					record.status = "awaiting_result";
					this.running.delete(record.id);
					try {
						this.save(record);
					} catch (error) {
						record.error = `Metadata persistence failed: ${String(error)}`.slice(0, 2000);
						this.records.set(record.id, record);
						this.changed();
					}
					if (!this.closing && record.outcome !== "stopped") {
						try {
							this.options.onReady?.(this.get(record.id));
						} catch {
							/* Notifications cannot alter results. */
						}
					}
				}
			})
			.catch((error: unknown) => {
				clearTimeout(timer);
				this.running.delete(record.id);
				record.status = "awaiting_result";
				record.outcome = "failed";
				record.error = String(error).slice(0, 2000);
				this.records.set(record.id, record);
				this.changed();
			});
		this.changed();
		return this.get(record.id);
	}

	pause(id: string): WorkflowRecord {
		const runtime = this.running.get(id);
		if (!runtime || this.closing || runtime.controller.signal.aborted)
			throw new Error("Workflow is not running in this runtime");
		const record = this.records.get(id)!;
		record.status = "paused";
		this.save(record);
		return this.get(id);
	}
	resume(id: string): WorkflowRecord {
		const runtime = this.running.get(id);
		const record = this.records.get(id);
		if (!runtime || !record || this.closing || runtime.controller.signal.aborted)
			throw new Error("Only a paused workflow in this runtime can resume; completed/old work is never restarted");
		if (record.status !== "paused") throw new Error("Workflow is not paused");
		record.status = "running";
		this.save(record);
		this.wake(runtime);
		return this.get(id);
	}
	async stop(id: string): Promise<WorkflowRecord> {
		const runtime = this.running.get(id);
		const record = this.get(id);
		if (!runtime && record.outcome === "unknown")
			throw new Error("Cannot control a workflow owned by a previous runtime");
		if (runtime) {
			runtime.failure = { outcome: "stopped", message: "Stopped by user; prior file changes are not undone" };
			runtime.controller.abort(new Error(runtime.failure.message));
			await runtime.done;
		}
		return this.get(id);
	}
	result(id: string, reportUsage = true): { workflow: WorkflowRecord; usage?: Usage } {
		// Preserve the object owned by late callbacks; never replace it with a public clone.
		const record = this.requireRecord(id);
		if (record.status !== "awaiting_result" && record.status !== "archived")
			throw new Error("Workflow result is not ready; do not wait or poll");
		const usage = reportUsage && !record.usageReported ? structuredClone(record.usage) : undefined;
		this.save(record, {
			resultRead: true,
			...(usage ? { usageReported: true, usageReportedTokens: usage.totalTokens } : {}),
		});
		return { workflow: this.get(id), usage };
	}
	acknowledge(id: string, summary: string): WorkflowRecord {
		if (this.closing) throw new Error("Workflow runtime is shutting down");
		const record = this.requireRecord(id);
		if (!summary.trim() || summary.length > 1000)
			throw new Error("acknowledge requires a 1–1000 character processing summary");
		if (record.status === "archived") return this.get(id);
		if (record.status !== "awaiting_result" || !record.resultRead)
			throw new Error("Read the ready result with workflow result, process it, then acknowledge");
		this.save(record, { status: "archived", acknowledgedAt: Date.now(), acknowledgement: summary });
		return this.get(id);
	}
	close(): Promise<void> {
		if (this.closed) return this.closed;
		this.closing = true;
		for (const runtime of this.running.values()) {
			runtime.failure = { outcome: "stopped", message: "Session shutdown" };
			runtime.controller.abort(new Error("Session shutdown"));
		}
		this.closed = Promise.all([...this.running.values()].map((runtime) => runtime.done)).then(() => {});
		return this.closed;
	}
}

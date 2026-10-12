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
import { type JsonValue, StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { safeText } from "../task-monitor/manager.ts";
import { clampWorkflowThinkingLevel } from "./effort.ts";
import { prelude } from "./script.ts";
import {
	type AgentRecord,
	addUsage,
	agentSchema,
	type ChildRunner,
	defaultLimits,
	emptyUsage,
	type ScriptRunner,
	thinkingSchema,
	type WorkflowLimits,
	type WorkflowRecord,
} from "./types.ts";

const number = Type.Number({ minimum: 0 });
const usageSchema = Type.Object({
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	totalTokens: number,
	cost: Type.Object({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }),
});
const recordSchema = Type.Object({
	id: Type.String({ pattern: "^workflow-[a-f0-9-]{36}$" }),
	label: Type.String({ maxLength: 500 }),
	cwd: Type.String(),
	provider: Type.String(),
	model: Type.String(),
	thinkingLevel: Type.Optional(thinkingSchema),
	status: StringEnum(["running", "paused", "awaiting_result", "archived"] as const),
	outcome: Type.Optional(StringEnum(["completed", "failed", "stopped", "unknown"] as const)),
	phase: Type.String({ maxLength: 500 }),
	agents: Type.Array(
		Type.Object({
			id: Type.String(),
			role: StringEnum(["scout", "worker", "reviewer", "summarizer"] as const),
			label: Type.String({ maxLength: 200 }),
			phase: Type.String({ maxLength: 500 }),
			status: StringEnum(["queued", "running", "completed", "failed", "stopped"] as const),
			output: Type.Optional(Type.String({ maxLength: 16384 })),
			error: Type.Optional(Type.String({ maxLength: 2000 })),
			turns: Type.Optional(number),
			thinkingLevel: Type.Optional(thinkingSchema),
		}),
		{ maxItems: 32 },
	),
	usage: usageSchema,
	createdAt: number,
	updatedAt: number,
	result: Type.Optional(Type.String({ maxLength: 65536 })),
	error: Type.Optional(Type.String({ maxLength: 2000 })),
	resultRead: Type.Optional(Type.Boolean()),
	usageReported: Type.Optional(Type.Boolean()),
	acknowledgedAt: Type.Optional(number),
	acknowledgement: Type.Optional(Type.String({ maxLength: 1000 })),
});
const controlSchema = Type.Object(
	{
		action: StringEnum(["phase", "log", "checkpoint"] as const),
		text: Type.Optional(Type.String({ maxLength: 500 })),
	},
	{ additionalProperties: false },
);

interface Runtime {
	controller: AbortController;
	done: Promise<void>;
	wake: Set<() => void>;
	children: Set<Promise<unknown>>;
	active: number;
	logBytes: number;
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
				if (!Check(recordSchema, record) || `${record.id}.json` !== name) continue;
				if (record.status === "running" || record.status === "paused") {
					record.status = "awaiting_result";
					record.outcome = "unknown";
					record.error =
						"Previous runtime ended without a confirmed result. Nothing is automatically resumed or restarted.";
					for (const agent of record.agents)
						if (agent.status === "running" || agent.status === "queued") {
							agent.status = "stopped";
							agent.error = "Previous runtime; result unknown";
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
	get(id: string): WorkflowRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown workflow: ${id}`);
		return structuredClone(record);
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
	private save(record: WorkflowRecord): void {
		record.updatedAt = Date.now();
		const path = join(this.directory, `${record.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
		renameSync(temporary, path);
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
		if (record.usage.totalTokens >= this.limits.maxTotalTokens) throw new Error("Workflow token budget exhausted");
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
		const record: WorkflowRecord = {
			id: `workflow-${randomUUID()}`,
			label: options.label,
			cwd,
			provider: options.provider,
			model: options.model,
			thinkingLevel,
			status: "running",
			phase: "Start",
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
			done: Promise.resolve(),
			wake: new Set(),
			children: new Set(),
			active: 0,
			logBytes: 0,
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
						status: "queued",
						thinkingLevel: childThinkingLevel,
					};
					record.agents.push(agent);
					const execution = (async () => {
						let acquired = false;
						try {
							while (true) {
								await this.gate(record, runtime, signal);
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
								beforeRequest: () => this.gate(record, runtime, signal),
								onUsage: (usage) => {
									addUsage(record.usage, usage);
									if (record.usage.totalTokens >= this.limits.maxTotalTokens) {
										runtime.failure = {
											outcome: "failed",
											message: "Workflow token budget exhausted; in-flight usage may exceed the budget",
										};
										runtime.controller.abort(new Error(runtime.failure.message));
									}
									this.save(record);
								},
							});
							signal.throwIfAborted();
							agent.status = "completed";
							agent.output = result.output.slice(0, 16384);
							agent.turns = result.turns;
							this.log(record, runtime, `Agent completed: ${agent.id}`);
							const value: JsonValue = { id: agent.id, role: agent.role, output: agent.output };
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
							record.phase = input.text;
							this.save(record);
						}
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
					record.result = result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
						.slice(0, 65536);
					record.outcome = result.isError ? "failed" : "completed";
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
		const record = this.get(id);
		if (record.status !== "awaiting_result" && record.status !== "archived")
			throw new Error("Workflow result is not ready; do not wait or poll");
		const usage = reportUsage && !record.usageReported ? structuredClone(record.usage) : undefined;
		record.resultRead = true;
		if (reportUsage) record.usageReported = true;
		this.save(record);
		return { workflow: this.get(id), usage };
	}
	acknowledge(id: string, summary: string): WorkflowRecord {
		if (this.closing) throw new Error("Workflow runtime is shutting down");
		const record = this.get(id);
		if (!summary.trim() || summary.length > 1000)
			throw new Error("acknowledge requires a 1–1000 character processing summary");
		if (record.status === "archived") return record;
		if (record.status !== "awaiting_result" || !record.resultRead)
			throw new Error("Read the ready result with workflow result, process it, then acknowledge");
		record.status = "archived";
		record.acknowledgedAt = Date.now();
		record.acknowledgement = summary;
		this.save(record);
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

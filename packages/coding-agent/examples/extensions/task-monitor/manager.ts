import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const recordSchema = Type.Object({
	id: Type.String({ pattern: "^(task|job)-[a-f0-9-]{36}$" }),
	kind: Type.Union([Type.Literal("task"), Type.Literal("job")]),
	label: Type.String({ maxLength: 500 }),
	status: Type.Union([
		Type.Literal("pending"),
		Type.Literal("running"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("stopped"),
		Type.Literal("unknown"),
		Type.Literal("awaiting_result"),
	]),
	review: Type.Optional(Type.Union([Type.Literal("awaiting"), Type.Literal("acknowledged")])),
	resultStatus: Type.Optional(
		Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("unknown")]),
	),
	acknowledgedAt: Type.Optional(Type.Number()),
	acknowledgement: Type.Optional(Type.String({ maxLength: 1000 })),
	dependencies: Type.Array(Type.String(), { maxItems: 100 }),
	createdAt: Type.Number(),
	updatedAt: Type.Number(),
	command: Type.Optional(Type.String({ maxLength: 32768 })),
	cwd: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Number()),
	error: Type.Optional(Type.String()),
});

export interface TaskRecord {
	id: string;
	kind: "task" | "job";
	label: string;
	status: "pending" | "running" | "completed" | "failed" | "stopped" | "unknown" | "awaiting_result";
	review?: "awaiting" | "acknowledged";
	resultStatus?: "completed" | "failed" | "stopped" | "unknown";
	acknowledgedAt?: number;
	acknowledgement?: string;
	dependencies: string[];
	createdAt: number;
	updatedAt: number;
	command?: string;
	cwd?: string;
	taskId?: string;
	exitCode?: number;
	error?: string;
}

export interface MonitorRecord {
	id: string;
	jobId: string;
	pattern: string;
	status: "watching" | "completed" | "stopped" | "expired" | "limit";
	matches: number;
	maxEvents: number;
	expiresAt: number;
}

export type TaskEvent =
	| { type: "completion"; record: TaskRecord }
	| { type: "match"; record: TaskRecord; monitorId: string; line: string };

export interface TaskManagerOptions {
	storageRoot: string;
	sessionId: string;
	operations: BashOperations;
	allowedCwdRoots?: string[];
	maxLogBytes?: number;
	maxRunningJobs?: number;
	onChange?: () => void;
	onEvent?: (event: TaskEvent) => void;
}

interface RunningJob {
	controller: AbortController;
	done: Promise<void>;
	stopReason?: string;
}

interface ActiveMonitor {
	record: MonitorRecord;
	timer: NodeJS.Timeout;
	lastEventAt: number;
	intervalMs: number;
}

export function safeText(text: string): string {
	// Logs may contain terminal escape sequences and non-printing control bytes.
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Session-wide external state: navigating the conversation tree does not undo real jobs. */
export class TaskManager {
	private readonly options: TaskManagerOptions;
	private readonly directory: string;
	private readonly records = new Map<string, TaskRecord>();
	private readonly running = new Map<string, RunningJob>();
	private readonly monitors = new Map<string, ActiveMonitor>();
	private closing = false;
	private closed: Promise<void> | undefined;

	constructor(options: TaskManagerOptions) {
		this.options = options;
		const sessionKey = createHash("sha256").update(options.sessionId).digest("hex");
		this.directory = join(options.storageRoot, sessionKey);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(this.directory)
			.filter((name) => /^(task|job)-[a-f0-9-]{36}\.json$/.test(name))
			.slice(0, 1000)) {
			const path = join(this.directory, name);
			try {
				if (statSync(path).size > 65536) continue;
				const record: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!Check(recordSchema, record) || `${record.id}.json` !== name) continue;
				if (record.kind === "job" && record.status === "running") {
					// Never signal a PID recovered from disk: it may belong to another process now.
					record.status = "unknown";
					record.error = "Owned by a previous or different Pi runtime; live state cannot be confirmed here.";
				}
				if (["completed", "failed", "stopped", "unknown"].includes(record.status)) record.review ??= "awaiting";
				this.records.set(record.id, record);
			} catch {
				// A corrupt record must not prevent access to the remaining task history.
			}
		}
		for (const job of this.records.values()) {
			const task = job.taskId ? this.records.get(job.taskId) : undefined;
			if (
				task &&
				task.review !== "acknowledged" &&
				job.review === "awaiting" &&
				(job.status === "completed" ||
					job.status === "failed" ||
					job.status === "stopped" ||
					job.status === "unknown")
			) {
				task.status = "awaiting_result";
				task.resultStatus = job.status;
				task.review = "awaiting";
			}
		}
	}

	list(includeArchived = false): TaskRecord[] {
		return [...this.records.values()]
			.filter((record) => includeArchived || record.review !== "acknowledged")
			.map((record) => structuredClone(record));
	}

	get(id: string): TaskRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown task/job: ${id}`);
		return structuredClone(record);
	}

	private save(record: TaskRecord): void {
		record.updatedAt = Date.now();
		const path = join(this.directory, `${record.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
		renameSync(temporary, path);
		this.records.set(record.id, record);
		this.changed();
	}

	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* UI observers cannot change process outcomes. */
		}
	}

	private emit(event: TaskEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch {
			/* Notification observers cannot crash a shell output handler. */
		}
	}

	private finishRecord(record: TaskRecord): void {
		try {
			this.save(record);
		} catch (error) {
			record.error = `${record.error ? `${record.error}; ` : ""}Metadata persistence failed: ${String(error)}`;
			this.records.set(record.id, record);
			this.changed();
		}
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("Task runtime is shutting down");
		if (this.records.size >= 1000) throw new Error("Session task limit reached (1000)");
	}

	createTask(label: string, dependencies: string[] = []): TaskRecord {
		this.assertOpen();
		if (!label.trim() || label.length > 500) throw new Error("Task label must contain 1–500 characters");
		if (dependencies.length > 100) throw new Error("At most 100 dependencies are supported");
		for (const id of dependencies) {
			if (this.get(id).kind !== "task") throw new Error("Dependencies must be logical task IDs");
		}
		// Only previously created tasks can be dependencies, so cycles cannot be introduced.
		const record: TaskRecord = {
			id: `task-${randomUUID()}`,
			kind: "task",
			label,
			status: "pending",
			dependencies: [...new Set(dependencies)],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.save(record);
		return this.get(record.id);
	}

	updateTask(id: string, status: "pending" | "running" | "completed" | "stopped"): TaskRecord {
		if (this.closing) throw new Error("Task runtime is shutting down");
		const record = this.get(id);
		if (record.kind !== "task") throw new Error("Job status comes from process execution, not manual updates");
		if (this.list().some((job) => job.taskId === id && (job.status === "running" || job.status === "unknown"))) {
			throw new Error("Task has a live or unmanaged job; stop or resolve that job first");
		}
		if (record.status === "awaiting_result") throw new Error("Result is ready; use acknowledge after processing it");
		if (record.review === "acknowledged") throw new Error("Archived tasks cannot be restarted; create a new task");
		if (status === "running" || status === "completed") this.checkDependencies(record);
		record.status = status;
		// Manually marking a logical task complete is already an explicit processing decision.
		if (status === "completed") {
			record.review = "acknowledged";
			record.acknowledgedAt = Date.now();
		} else if (status === "stopped") record.review = "awaiting";
		this.save(record);
		return this.get(id);
	}

	acknowledge(id: string, summary: string): TaskRecord {
		if (this.closing) throw new Error("Task runtime is shutting down");
		if (!summary.trim() || summary.length > 1000)
			throw new Error("Acknowledgement requires a 1–1000 character processing summary");
		const record = this.get(id);
		const job = record.kind === "job" ? record : this.list(true).find((entry) => entry.taskId === id);
		const task = record.kind === "task" ? record : record.taskId ? this.get(record.taskId) : undefined;
		const related = [job, task].filter((entry): entry is TaskRecord => entry !== undefined);
		for (const entry of related) {
			if (["pending", "running", "unknown"].includes(entry.status) || entry.resultStatus === "unknown")
				throw new Error("Cannot acknowledge unfinished or unmanaged work");
		}
		for (const entry of related) {
			if (entry.review === "acknowledged") continue;
			if (entry.status === "awaiting_result") entry.status = entry.resultStatus ?? "failed";
			entry.review = "acknowledged";
			entry.acknowledgedAt = Date.now();
			entry.acknowledgement = summary;
			this.save(entry);
		}
		return this.get(id);
	}

	private checkDependencies(record: TaskRecord): void {
		const blocked = record.dependencies.filter((id) => {
			const dependency = this.get(id);
			return dependency.status !== "completed" || dependency.review === "awaiting";
		});
		if (blocked.length) throw new Error(`Task is blocked by unfinished dependencies: ${blocked.join(", ")}`);
	}

	start(options: { command: string; cwd: string; label: string; timeout?: number; taskId?: string }): TaskRecord {
		this.assertOpen();
		if (!options.command.trim() || options.command.length > 32768)
			throw new Error("Command must contain 1–32768 characters");
		if (!options.label.trim() || options.label.length > 500)
			throw new Error("Job label must contain 1–500 characters");
		if (this.running.size >= (this.options.maxRunningJobs ?? 8)) throw new Error("Running job limit reached");
		if (!isAbsolute(options.cwd)) throw new Error("Job cwd must be an explicit absolute workspace directory");
		const cwd = realpathSync(options.cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("Job cwd is not a directory");
		if (
			this.options.allowedCwdRoots &&
			!this.options.allowedCwdRoots.some((root) => {
				const child = relative(realpathSync(root), cwd);
				return (
					child === "" ||
					(child !== ".." &&
						!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
						!isAbsolute(child))
				);
			})
		)
			throw new Error("Job cwd is outside configured workspace roots (this check is not a shell sandbox)");
		const timeout = options.timeout ?? 86400;
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 604800)
			throw new Error("Timeout must be positive and at most 604800 seconds");
		const task = options.taskId ? this.get(options.taskId) : undefined;
		if (task) {
			if (task.kind !== "task" || task.status !== "pending") throw new Error("Linked task must be pending");
			this.checkDependencies(task);
		}
		const record: TaskRecord = {
			id: `job-${randomUUID()}`,
			kind: "job",
			label: options.label,
			status: "running",
			dependencies: [],
			command: options.command,
			cwd,
			...(task ? { taskId: task.id } : {}),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		writeFileSync(this.logPath(record.id), "", { flag: "wx", mode: 0o600 });
		try {
			this.save(record);
			if (task) {
				task.status = "running";
				this.save(task);
			}
		} catch (error) {
			// No command has been launched yet; never leave a phantom running job.
			record.status = "failed";
			record.review = "awaiting";
			record.error = `Failed before command launch: ${String(error)}`;
			this.finishRecord(record);
			if (task) {
				task.status = "awaiting_result";
				task.resultStatus = "failed";
				task.review = "awaiting";
				task.error = record.error;
				this.finishRecord(task);
			}
			throw error;
		}
		const runtime: RunningJob = { controller: new AbortController(), done: Promise.resolve() };
		this.running.set(record.id, runtime);
		const decoder = new StringDecoder("utf8");
		let lineBuffer = "";
		let bytes = 0;
		let acceptingOutput = true;
		const maxBytes = this.options.maxLogBytes ?? 10 * 1024 * 1024;
		const onData = (chunk: Buffer) => {
			if (!acceptingOutput || runtime.stopReason) return;
			const accepted = chunk.subarray(0, Math.max(0, maxBytes - bytes));
			try {
				if (accepted.length) appendFileSync(this.logPath(record.id), accepted);
			} catch (error) {
				runtime.stopReason = `Log write failed: ${String(error)}`;
				runtime.controller.abort();
				return;
			}
			bytes += accepted.length;
			lineBuffer += decoder.write(accepted);
			let end = lineBuffer.indexOf("\n");
			while (end !== -1) {
				this.matchLine(record, safeText(lineBuffer.slice(0, end)));
				lineBuffer = lineBuffer.slice(end + 1);
				end = lineBuffer.indexOf("\n");
			}
			// A command printing a single unbounded line cannot grow monitor memory indefinitely.
			if (lineBuffer.length > 8192) {
				this.matchLine(record, safeText(lineBuffer));
				lineBuffer = lineBuffer.slice(-1024);
			}
			if (chunk.length > accepted.length) {
				runtime.stopReason = `Log limit reached (${maxBytes} bytes); job stopped to bound disk usage`;
				runtime.controller.abort();
			}
		};
		// A separate controller makes explicit background work independent of the launching turn.
		// The promise belongs to this manager, not to the agent's tool batch or waitForIdle().
		runtime.done = Promise.resolve()
			.then(() =>
				this.options.operations.exec(options.command, cwd, {
					onData,
					signal: runtime.controller.signal,
					timeout,
				}),
			)
			.then(
				({ exitCode }) => {
					if (exitCode !== null) record.exitCode = exitCode;
					record.status = exitCode === 0 ? "completed" : "failed";
				},
				(error: unknown) => {
					record.status = "failed";
					record.error = String(error);
				},
			)
			.then(() => {
				acceptingOutput = false;
				lineBuffer += decoder.end();
				if (lineBuffer) this.matchLine(record, safeText(lineBuffer));
				if (runtime.stopReason) {
					record.status =
						runtime.stopReason === "Stopped by user" || runtime.stopReason === "Session shutdown"
							? "stopped"
							: "failed";
					record.error = runtime.stopReason;
				}
				this.running.delete(record.id);
				record.review = "awaiting";
				this.finishRecord(record);
				if (task) {
					task.status = "awaiting_result";
					task.resultStatus =
						record.status === "completed" ? "completed" : record.status === "stopped" ? "stopped" : "failed";
					task.review = "awaiting";
					task.error = record.error;
					this.finishRecord(task);
				}
				for (const monitor of this.monitors.values()) {
					if (monitor.record.jobId === record.id && monitor.record.status === "watching")
						this.endMonitor(monitor, "completed");
				}
				if (!this.closing && record.status !== "stopped")
					this.emit({ type: "completion", record: this.get(record.id) });
			})
			.catch((error: unknown) => {
				// Storage/UI callback failures must not become unhandled promise rejections.
				this.running.delete(record.id);
				record.status = "failed";
				record.review = "awaiting";
				record.error = `Task finalization failed: ${String(error)}`;
				this.records.set(record.id, record);
			});
		this.changed();
		return this.get(record.id);
	}

	logPath(id: string): string {
		if (!/^job-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job ID");
		return join(this.directory, `${id}.log`);
	}

	readOutput(id: string, maxBytes = 8192): { output: string; truncated: boolean; logPath: string } {
		if (this.get(id).kind !== "job") throw new Error("Only jobs have logs");
		if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new Error("maxBytes must be 1–65536");
		const logPath = this.logPath(id);
		if (!existsSync(logPath)) return { output: "", truncated: false, logPath };
		const fd = openSync(logPath, "r");
		try {
			const size = statSync(logPath).size;
			const buffer = Buffer.alloc(Math.min(size, maxBytes));
			const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - maxBytes));
			return { output: safeText(buffer.subarray(0, count).toString("utf8")), truncated: size > maxBytes, logPath };
		} finally {
			closeSync(fd);
		}
	}

	async stop(id: string): Promise<TaskRecord> {
		const record = this.get(id);
		const runtime = this.running.get(id);
		if (runtime) {
			runtime.stopReason = "Stopped by user";
			runtime.controller.abort();
			await runtime.done;
		} else if (record.kind === "task") {
			return this.updateTask(id, "stopped");
		} else if (record.status === "unknown") {
			throw new Error("Cannot stop a job owned by a different runtime; no stored PID will be signalled");
		}
		return this.get(id);
	}

	watch(
		jobId: string,
		pattern: string,
		options: { durationSeconds?: number; maxEvents?: number; intervalMs?: number } = {},
	): MonitorRecord {
		if (this.closing) throw new Error("Task runtime is shutting down");
		if (!this.running.has(jobId)) throw new Error("Monitor requires a job running in this runtime");
		if (!pattern || pattern.length > 1000)
			throw new Error("Monitor pattern must contain 1–1000 characters (literal substring, not regex)");
		if (this.monitors.size >= 100) throw new Error("Session monitor limit reached (100)");
		const duration = options.durationSeconds ?? 300;
		const maxEvents = options.maxEvents ?? 20;
		const intervalMs = options.intervalMs ?? 3000;
		if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
			throw new Error("Monitor duration must be 0–86400 seconds, excluding zero");
		if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) throw new Error("maxEvents must be 1–100");
		if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
			throw new Error("intervalMs must be 1000–60000");
		const record: MonitorRecord = {
			id: `monitor-${randomUUID()}`,
			jobId,
			pattern,
			status: "watching",
			matches: 0,
			maxEvents,
			expiresAt: Date.now() + duration * 1000,
		};
		const monitor: ActiveMonitor = {
			record,
			lastEventAt: 0,
			intervalMs,
			timer: setTimeout(() => this.endMonitor(monitor, "expired"), duration * 1000),
		};
		this.monitors.set(record.id, monitor);
		this.changed();
		return structuredClone(record);
	}

	listMonitors(): MonitorRecord[] {
		return [...this.monitors.values()].map(({ record }) => structuredClone(record));
	}

	stopMonitor(id: string): MonitorRecord {
		const monitor = this.monitors.get(id);
		if (!monitor) throw new Error(`Unknown monitor: ${id}`);
		this.endMonitor(monitor, "stopped");
		return structuredClone(monitor.record);
	}

	private endMonitor(monitor: ActiveMonitor, status: MonitorRecord["status"]): void {
		if (monitor.record.status !== "watching") return;
		clearTimeout(monitor.timer);
		monitor.record.status = status;
		this.changed();
	}

	private matchLine(record: TaskRecord, line: string): void {
		if (this.closing) return;
		for (const monitor of this.monitors.values()) {
			if (
				monitor.record.jobId !== record.id ||
				monitor.record.status !== "watching" ||
				!line.includes(monitor.record.pattern)
			)
				continue;
			const now = Date.now();
			if (now - monitor.lastEventAt < monitor.intervalMs) continue;
			monitor.lastEventAt = now;
			monitor.record.matches++;
			this.emit({
				type: "match",
				record: this.get(record.id),
				monitorId: monitor.record.id,
				line: line.slice(0, 2000),
			});
			if (monitor.record.matches >= monitor.record.maxEvents) this.endMonitor(monitor, "limit");
		}
	}

	close(): Promise<void> {
		if (this.closed) return this.closed;
		this.closing = true;
		for (const monitor of this.monitors.values()) this.endMonitor(monitor, "stopped");
		for (const job of this.running.values()) {
			job.stopReason = "Session shutdown";
			job.controller.abort();
		}
		this.closed = Promise.all([...this.running.values()].map((job) => job.done)).then(() => {});
		return this.closed;
	}
}

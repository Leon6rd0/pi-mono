import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TaskEvent, TaskManager } from "../examples/extensions/task-monitor/manager.ts";

interface PendingExecution {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	resolve: (result: { exitCode: number | null }) => void;
	reject: (error: Error) => void;
}

function controlledBackend() {
	const executions: PendingExecution[] = [];
	const operations: BashOperations = {
		exec: (_command, _cwd, options) =>
			new Promise((resolve, reject) => {
				executions.push({ ...options, resolve, reject });
				if (options.signal?.aborted) reject(new Error("aborted"));
				else options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	};
	return { executions, operations };
}

const directories: string[] = [];
const managers: TaskManager[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "pi-task-monitor-"));
	directories.push(path);
	return path;
}
function manager(options: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
	const backend = controlledBackend();
	const events: TaskEvent[] = [];
	const root = directory();
	const current = new TaskManager({
		storageRoot: root,
		sessionId: "test-session",
		operations: backend.operations,
		onEvent: (event) => events.push(event),
		...options,
	});
	managers.push(current);
	return { current, backend, events, root };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(managers.splice(0).map((current) => current.close()));
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("background task manager", () => {
	it("returns an ID before command completion and updates it from the actual exit code", async () => {
		const { current, backend, events, root } = manager();
		const job = current.start({ command: "long-build", cwd: root, label: "build" });
		expect(job.status).toBe("running");
		await tick();
		backend.executions[0].onData(Buffer.from("building\n"));
		expect(current.get(job.id).status).toBe("running");
		expect(current.readOutput(job.id).output).toBe("building\n");
		backend.executions[0].resolve({ exitCode: 0 });
		await tick();
		expect(current.get(job.id)).toMatchObject({ status: "completed", exitCode: 0 });
		expect(events.map((event) => event.type)).toEqual(["completion"]);
	});

	it.each([7, null])("does not report exit code %s as success", async (exitCode) => {
		const { current, backend, root } = manager();
		const job = current.start({ command: "fail", cwd: root, label: "fail" });
		await tick();
		backend.executions[0].resolve({ exitCode });
		await tick();
		expect(current.get(job.id).status).toBe("failed");
	});

	it("stops owned jobs, suppresses completion follow-ups, and closes idempotently", async () => {
		const { current, backend, events, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		await tick();
		await current.stop(job.id);
		expect(backend.executions[0].signal?.aborted).toBe(true);
		expect(current.get(job.id).status).toBe("stopped");
		expect(events).toEqual([]);
		expect((await current.stop(job.id)).status).toBe("stopped");
		expect(current.close()).toBe(current.close());
		await expect(
			Promise.resolve().then(() => current.start({ command: "x", cwd: root, label: "x" })),
		).rejects.toThrow("shutting down");
	});

	it("enforces dependencies and derives linked task status from its job", async () => {
		const { current, backend, root } = manager();
		const first = current.createTask("configure");
		const second = current.createTask("build", [first.id]);
		expect(() => current.start({ command: "build", cwd: root, label: "build", taskId: second.id })).toThrow(
			"dependencies",
		);
		current.updateTask(first.id, "completed");
		const job = current.start({ command: "build", cwd: root, label: "build", taskId: second.id });
		expect(current.get(second.id).status).toBe("running");
		expect(() => current.updateTask(second.id, "completed")).toThrow("live or unmanaged");
		expect(() => current.start({ command: "duplicate", cwd: root, label: "duplicate", taskId: second.id })).toThrow(
			"pending",
		);
		await tick();
		backend.executions[0].resolve({ exitCode: 2 });
		await tick();
		expect(current.get(job.id).status).toBe("failed");
		expect(current.get(second.id)).toMatchObject({ status: "awaiting_result", resultStatus: "failed" });
		expect(current.list().map((record) => record.id)).toContain(second.id);
		expect(() => current.updateTask(second.id, "completed")).toThrow("acknowledge");
		current.acknowledge(job.id, "Read failure log; build failed, no retry requested");
		expect(current.get(second.id).status).toBe("failed");
		expect(current.list()).toEqual([]);
		expect(current.list(true)).toHaveLength(3);
		expect(current.readOutput(job.id).logPath).toBe(current.logPath(job.id));
	});

	it("only unlocks dependent work after the Agent acknowledges a successful result", async () => {
		const { current, backend, root } = manager();
		const build = current.createTask("build");
		const verify = current.createTask("verify", [build.id]);
		const job = current.start({ command: "build", cwd: root, label: "build", taskId: build.id });
		expect(() => current.acknowledge(job.id, "not done")).toThrow("unfinished");
		await tick();
		backend.executions[0].onData(Buffer.from("built\n"));
		backend.executions[0].resolve({ exitCode: 0 });
		await tick();
		expect(current.get(build.id).status).toBe("awaiting_result");
		expect(() => current.start({ command: "verify", cwd: root, label: "verify", taskId: verify.id })).toThrow(
			"dependencies",
		);
		current.acknowledge(build.id, "Verified exit 0 and retained build log");
		expect(current.get(build.id).status).toBe("completed");
		expect(current.get(job.id).review).toBe("acknowledged");
		current.acknowledge(job.id, "idempotent");
		expect(current.get(job.id).acknowledgement).toBe("Verified exit 0 and retained build log");
		expect(current.readOutput(job.id).output).toBe("built\n");
		const next = current.start({ command: "verify", cwd: root, label: "verify", taskId: verify.id });
		expect(next.status).toBe("running");
	});

	it("bounds disk output and stops a runaway producer", async () => {
		const { current, backend, root } = manager({ maxLogBytes: 32 });
		const job = current.start({ command: "noisy", cwd: root, label: "noisy" });
		await tick();
		backend.executions[0].onData(Buffer.alloc(128, "x"));
		await tick();
		expect(statSync(current.logPath(job.id)).size).toBe(32);
		expect(current.get(job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Log limit") });
		expect(current.readOutput(job.id, 8)).toMatchObject({ output: "xxxxxxxx", truncated: true });
	});

	it("sanitizes terminal controls without destroying retained raw logs", async () => {
		const { current, backend, root } = manager();
		const job = current.start({ command: "output", cwd: root, label: "output" });
		await tick();
		backend.executions[0].onData(Buffer.from("\x1b]52;c;bad\x07\x1b[31m中文\x1b[0m\x00\n"));
		expect(current.readOutput(job.id).output).toBe("中文\n");
		expect(readFileSync(current.logPath(job.id), "utf8")).toContain("\x1b");
		expect(() => current.readOutput(job.id, 65537)).toThrow("maxBytes");
		expect(() => current.logPath("../../escape")).toThrow("Invalid job ID");
	});

	it("UI and notification observer failures cannot crash output handling or change exit status", async () => {
		const { current, backend, root } = manager({
			onChange: () => {
				throw new Error("UI failed");
			},
			onEvent: () => {
				throw new Error("Notification failed");
			},
		});
		const job = current.start({ command: "worker", cwd: root, label: "worker" });
		current.watch(job.id, "READY");
		await tick();
		expect(() => backend.executions[0].onData(Buffer.from("READY\n"))).not.toThrow();
		backend.executions[0].resolve({ exitCode: 0 });
		await tick();
		expect(current.get(job.id).status).toBe("completed");
	});

	it("ignores output callbacks arriving after process completion", async () => {
		const { current, backend, root } = manager();
		const job = current.start({ command: "worker", cwd: root, label: "worker" });
		await tick();
		backend.executions[0].onData(Buffer.from("before\n"));
		backend.executions[0].resolve({ exitCode: 0 });
		await tick();
		backend.executions[0].onData(Buffer.from("late\n"));
		expect(current.readOutput(job.id).output).toBe("before\n");
	});

	it("validates workspace paths, timeouts and concurrency before launching", () => {
		const allowed = directory();
		const outside = directory();
		const { current } = manager({ allowedCwdRoots: [allowed], maxRunningJobs: 1 });
		expect(() => current.start({ command: "x", cwd: ".", label: "x" })).toThrow("absolute");
		expect(() => current.start({ command: "x", cwd: outside, label: "x" })).toThrow("workspace roots");
		expect(() => current.start({ command: "x", cwd: allowed, label: "x", timeout: Number.NaN })).toThrow("Timeout");
		current.start({ command: "x", cwd: allowed, label: "x" });
		expect(() => current.start({ command: "x", cwd: allowed, label: "x" })).toThrow("limit");
	});

	it("restores records but never assumes ownership of an old live process", async () => {
		const { current, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		const restored = new TaskManager({
			storageRoot: root,
			sessionId: "test-session",
			operations: controlledBackend().operations,
		});
		managers.push(restored);
		expect(restored.get(job.id).status).toBe("unknown");
		await expect(restored.stop(job.id)).rejects.toThrow("no stored PID");
		expect(current.get(job.id).status).toBe("running");
		await current.stop(job.id);
		const afterStop = new TaskManager({
			storageRoot: root,
			sessionId: "test-session",
			operations: controlledBackend().operations,
		});
		managers.push(afterStop);
		expect(afterStop.get(job.id).status).toBe("stopped");
	});

	it("ignores corrupt metadata", () => {
		const { current, root } = manager();
		const task = current.createTask("kept");
		const metadataDirectory = dirname(current.logPath(`job-${randomUUID()}`));
		writeFileSync(join(metadataDirectory, `task-${randomUUID()}.json`), "not-json");
		const restored = new TaskManager({
			storageRoot: root,
			sessionId: "test-session",
			operations: controlledBackend().operations,
		});
		managers.push(restored);
		expect(restored.get(task.id).label).toBe("kept");
		expect(restored.list()).toHaveLength(1);
	});
});

describe("local monitors", () => {
	it("matches literal substrings across chunks and throttles events", async () => {
		const { current, backend, events, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		const watch = current.watch(job.id, "READY.*", { maxEvents: 1 });
		await tick();
		backend.executions[0].onData(Buffer.from("REA"));
		backend.executions[0].onData(Buffer.from("DY.* 中文\nREADY.* again\n"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "match", monitorId: watch.id, line: "READY.* 中文" });
		expect(current.listMonitors()[0].status).toBe("limit");
	});

	it("does not repeatedly emit burst matches", async () => {
		const { current, backend, events, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		current.watch(job.id, "ERROR");
		await tick();
		backend.executions[0].onData(Buffer.from("ERROR one\nERROR two\nERROR three\n"));
		expect(events.filter((event) => event.type === "match")).toHaveLength(1);
	});

	it("expires without killing the underlying job", async () => {
		const { current, backend, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		current.watch(job.id, "ERROR", { durationSeconds: 0.02 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(current.listMonitors()[0].status).toBe("expired");
		expect(backend.executions[0].signal?.aborted).toBe(false);
	});

	it("stopping a watcher does not stop its job; job completion closes remaining watchers", async () => {
		const { current, backend, root } = manager();
		const job = current.start({ command: "server", cwd: root, label: "server" });
		const one = current.watch(job.id, "one");
		const two = current.watch(job.id, "two");
		current.stopMonitor(one.id);
		await tick();
		expect(backend.executions[0].signal?.aborted).toBe(false);
		backend.executions[0].resolve({ exitCode: 0 });
		await tick();
		expect(current.listMonitors().find((watch) => watch.id === two.id)?.status).toBe("completed");
		expect(() => current.watch(job.id, "late")).toThrow("running");
	});
});

describe.skipIf(process.platform !== "linux")("real local shell cleanup", () => {
	it("handles completion and timeout without a paid provider", async () => {
		const { current, root } = manager({ operations: createLocalBashOperations() });
		const good = current.start({ command: "printf 'real-shell-ok\\n'", cwd: root, label: "real shell" });
		await vi.waitFor(() => expect(current.get(good.id).status).toBe("completed"));
		expect(current.readOutput(good.id).output).toBe("real-shell-ok\n");
		const timeout = current.start({ command: "sleep 30", cwd: root, label: "timeout", timeout: 0.05 });
		await vi.waitFor(() => expect(current.get(timeout.id).status).toBe("failed"));
		expect(current.get(timeout.id).error).toContain("timeout");
	});

	it("explicit stop kills the shell process group, including a child", async () => {
		const { current, root } = manager({ operations: createLocalBashOperations() });
		const script = join(root, "child.mjs");
		writeFileSync(
			script,
			"import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);\n",
		);
		const job = current.start({ command: `"${process.execPath}" "${script}"`, cwd: root, label: "child tree" });
		await vi.waitFor(() => expect(current.readOutput(job.id).output.trim()).toMatch(/^\d+$/));
		const pid = Number(current.readOutput(job.id).output.trim());
		await current.stop(job.id);
		expect(current.get(job.id).status).toBe("stopped");
		await vi.waitFor(() => {
			// Linux can briefly retain a killed child as a zombie until its new parent reaps it.
			try {
				const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0);
				expect(state).toBe("Z");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type BashOperations, type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskMonitorExtension } from "../../examples/extensions/task-monitor/index.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
interface Execution {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	resolve: (value: { exitCode: number | null }) => void;
}
async function setup(options: { notifyModel?: boolean; gate?: (pi: ExtensionAPI) => void; tools?: AgentTool[] } = {}) {
	const storageRoot = mkdtempSync(join(tmpdir(), "pi-task-integration-"));
	directories.push(storageRoot);
	const executions: Execution[] = [];
	const notices: string[] = [];
	const operations: BashOperations = {
		exec: (_command, _cwd, execOptions) =>
			new Promise((resolve, reject) => {
				executions.push({ ...execOptions, resolve });
				if (execOptions.signal?.aborted) reject(new Error("aborted"));
				else execOptions.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	};
	const harness = await createHarness({
		tools: options.tools,
		extensionFactories: [
			createTaskMonitorExtension({ storageRoot, operations, notifyModel: options.notifyModel }),
			...(options.gate ? [options.gate] : []),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "rpc",
		uiContext: createTestUiContext({ notify: (text) => notices.push(text) }),
	});
	return { harness, executions, notices };
}
async function launch(harness: Harness, label = "build") {
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("background", { action: "start", command: "long-running-command", cwd: harness.tempDir, label }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Job started; the conversation is available."),
	]);
	await harness.session.prompt("Start the build in the background");
	const result = getToolResult(harness, "background");
	expect(result.isError).toBe(false);
	return (result.details as { job: { id: string; status: string } }).job;
}
const notificationDelay = () => new Promise((resolve) => setTimeout(resolve, 1150));

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("task monitor integration (faux provider only)", () => {
	it("settles the launching turn while a job is running, and accepts another prompt", async () => {
		const { harness, executions } = await setup();
		const job = await launch(harness);
		expect(job.status).toBe("running");
		expect(executions).toHaveLength(1);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.waitForIdle();
		harness.setResponses([fauxAssistantMessage("Another question answered while the build is running.")]);
		await harness.session.prompt("Explain what we are building");
		expect(executions[0].signal?.aborted).toBe(false);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it("allows permission hooks to block background launch before process execution", async () => {
		const { harness, executions } = await setup({
			gate: (pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "background" && event.input.action === "start")
						return { block: true, reason: "Launch not approved" };
				});
			},
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", { action: "start", command: "blocked", cwd: harness.tempDir, label: "blocked" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Not started."),
		]);
		await harness.session.prompt("Try launch");
		expect(getToolResult(harness, "background").isError).toBe(true);
		expect(executions).toHaveLength(0);
	});

	it("delivers one event-driven follow-up after real job completion, with no polling requests", async () => {
		const { harness, executions, notices } = await setup();
		const job = await launch(harness);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		let sawEvent = false;
		harness.appendResponses([
			(context) => {
				sawEvent =
					JSON.stringify(context.messages).includes(job.id) &&
					JSON.stringify(context.messages).includes("Background task event");
				return fauxAssistantMessage("Build completed.");
			},
		]);
		await notificationDelay();
		expect(harness.getPendingResponseCount()).toBe(1);
		executions[0].resolve({ exitCode: 0 });
		await notificationDelay();
		await harness.session.waitForIdle();
		expect(sawEvent).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(notices.some((text) => text.includes("completed"))).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it("monitor returns immediately, observes output locally, and does not stop its job", async () => {
		const { harness, executions, notices } = await setup({ notifyModel: false });
		const job = await launch(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("monitor", { action: "start", job_id: job.id, pattern: "READY", max_events: 1 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Monitoring locally; you can continue chatting."),
		]);
		await harness.session.prompt("Watch for readiness");
		expect(getToolResult(harness, "monitor").isError).toBe(false);
		executions[0].onData(Buffer.from("REA"));
		executions[0].onData(Buffer.from("DY\n"));
		await notificationDelay();
		expect(notices.some((text) => text.includes("matched"))).toBe(true);
		expect(executions[0].signal?.aborted).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("keeps a completion notification even when many watcher matches fill the event queue", async () => {
		const { harness, executions, notices } = await setup({ notifyModel: false });
		const job = await launch(harness);
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 25 }, () =>
					fauxToolCall("monitor", { action: "start", job_id: job.id, pattern: "READY", max_events: 1 }),
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Watchers registered."),
		]);
		await harness.session.prompt("Register watchers");
		expect(
			harness.eventsOfType("tool_execution_end").filter((event) => event.toolName === "monitor" && !event.isError),
		).toHaveLength(25);
		executions[0].onData(Buffer.from("READY\n"));
		executions[0].resolve({ exitCode: 0 });
		await notificationDelay();
		expect(notices.some((text) => text.includes(`${job.id}: completed`))).toBe(true);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("does not restart the model after Escape/abort; a background job remains explicitly controllable", async () => {
		const { harness, executions } = await setup();
		await launch(harness);
		await harness.session.extensionRunner.emit({ type: "agent_settled", aborted: true });
		harness.appendResponses([fauxAssistantMessage("Must not be auto-consumed")]);
		executions[0].resolve({ exitCode: 0 });
		await notificationDelay();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("user stop command works during a busy foreground tool and does not wake another model turn", async () => {
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const toolStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const foreground: AgentTool = {
			name: "foreground_hold",
			label: "Hold",
			description: "Hold a foreground tool",
			parameters: Type.Object({}),
			execute: async () => {
				started?.();
				await hold;
				return { content: [{ type: "text", text: "released" }], details: undefined };
			},
		};
		const { harness, executions } = await setup({ tools: [foreground] });
		const job = await launch(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("foreground_hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Foreground complete."),
		]);
		const prompt = harness.session.prompt("Run the foreground step");
		await toolStarted;
		try {
			await harness.session.prompt(`/tasks stop ${job.id}`);
			expect(executions[0].signal?.aborted).toBe(true);
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			release?.();
		}
		await prompt;
		await notificationDelay();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it("shutdown stops jobs and watchers without late notifications or stale-runtime access", async () => {
		const { harness, executions, notices } = await setup();
		const job = await launch(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("monitor", { action: "start", job_id: job.id, pattern: "MATCH" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Watching."),
		]);
		await harness.session.prompt("Watch output");
		executions[0].onData(Buffer.from("MATCH\n"));
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(executions[0].signal?.aborted).toBe(true);
		await notificationDelay();
		expect(notices.filter((text) => text.includes("matched"))).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("archives handled results, preserves logs, and suppresses an already queued completion", async () => {
		const { harness, executions, notices } = await setup();
		const job = await launch(harness);
		executions[0].onData(Buffer.from("handled output\n"));
		executions[0].resolve({ exitCode: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "status", id: job.id }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("tasks", {
					action: "acknowledge",
					id: job.id,
					summary: "Read log and handled successful result",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("tasks", { action: "list" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Result processed and archived."),
		]);
		await harness.session.prompt("Process the ready result");
		expect(getToolResult(harness, "tasks").details).toEqual({ total: 0, tasks: [] });
		expect(JSON.stringify(getToolResult(harness, "background").details)).toContain("handled output");
		await notificationDelay();
		expect(notices.some((text) => text.includes(`${job.id}: completed`))).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("shows a compact live widget that fits narrow terminals and wide labels", async () => {
		initTheme("dark", false);
		const { harness } = await setup({ notifyModel: false });
		const widths: number[] = [];
		const ui = createTestUiContext({
			setWidget: (_key, content) => {
				if (typeof content !== "function") return;
				const component = content({} as Parameters<typeof content>[0], ui.theme);
				widths.push(...component.render(25).map((line) => visibleWidth(line)));
			},
		});
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui });
		await launch(harness, "后台构建\n中文宽字符");
		expect(widths.length).toBeGreaterThan(0);
		expect(widths.every((width) => width <= 25)).toBe(true);
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(false));
	});
});

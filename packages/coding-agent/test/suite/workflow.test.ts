import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type JsonObject } from "@earendil-works/pi-ai";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildRunner, workspacePath } from "../../examples/extensions/workflow/child-agent.ts";
import { createWorkflowExtension, type WorkflowOptions } from "../../examples/extensions/workflow/index.ts";
import { WorkflowManager } from "../../examples/extensions/workflow/manager.ts";
import {
	type ChildOptions,
	type ChildResult,
	type ChildRunner,
	emptyUsage,
} from "../../examples/extensions/workflow/types.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const extraManagers: WorkflowManager[] = [];
const directories: string[] = [];
const resultPaths = new Map<string, string>();
interface Execution {
	options: ChildOptions;
	complete(output: string, tokens?: number): void;
}
async function setup(options: WorkflowOptions = {}, gate?: (pi: ExtensionAPI) => void) {
	const executions: Execution[] = [];
	const notices: string[] = [];
	const storageRoot = mkdtempSync(join(tmpdir(), "pi-workflow-"));
	directories.push(storageRoot);
	const controlled: ChildRunner = async (options) => {
		await options.beforeRequest();
		options.signal.throwIfAborted();
		return new Promise<ChildResult>((resolve, reject) => {
			const abort = () => reject(new Error("child aborted"));
			options.signal.addEventListener("abort", abort, { once: true });
			executions.push({
				options,
				complete: (output, tokens = 12) => {
					options.signal.removeEventListener("abort", abort);
					const usage = emptyUsage();
					usage.totalTokens = tokens;
					usage.output = tokens;
					options.onUsage(usage);
					resolve({ output, usage, turns: 1 });
				},
			});
		});
	};
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			createWorkflowExtension({ storageRoot, notifyModel: false, runChild: controlled, ...options }),
			...(gate ? [gate] : []),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "rpc",
		uiContext: createTestUiContext({ notify: (text) => notices.push(text) }),
	});
	return { harness, executions, notices };
}
async function actualSetup(options: WorkflowOptions = {}) {
	let actual: ChildRunner | undefined;
	let release: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result = await setup(
		{
			...options,
			runChild: async (child) => {
				child.signal.throwIfAborted();
				let abort: (() => void) | undefined;
				try {
					await Promise.race([
						barrier,
						new Promise<never>((_resolve, reject) => {
							abort = () => reject(new Error("child aborted before test release"));
							child.signal.addEventListener("abort", abort, { once: true });
						}),
					]);
				} finally {
					if (abort) child.signal.removeEventListener("abort", abort);
				}
				if (!actual) throw new Error("No runner");
				return actual(child);
			},
		},
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (ctx.model) actual = createChildRunner(ctx.modelRegistry, ctx.model);
			});
		},
	);
	return { ...result, release: () => release?.() };
}
async function call(harness: Harness, args: JsonObject) {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("workflow", args), { stopReason: "toolUse" }),
		fauxAssistantMessage("Handled; conversation available."),
	]);
	await harness.session.prompt("Handle Workflow operation");
	return getToolResult(harness, "workflow");
}
async function launch(harness: Harness, code = "return await agent('Inspect the workspace', {role:'scout'});") {
	const result = await call(harness, { action: "start", label: "isolated workflow", cwd: harness.tempDir, code });
	expect(result.isError).toBe(false);
	const started = result.details as { workflow: { id: string }; logPath: string; resultPath: string };
	resultPaths.set(started.workflow.id, started.resultPath);
	return started;
}
async function ready(_harness: Harness, id: string) {
	// Assert local persistence, not repeated model/tool status requests.
	await vi.waitFor(
		() => {
			const path = resultPaths.get(id);
			if (!path) throw new Error("No workflow result path");
			expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("awaiting_result");
		},
		{ timeout: 4000 },
	);
}

afterEach(async () => {
	await Promise.all(extraManagers.splice(0).map((manager) => manager.close()));
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	resultPaths.clear();
});

describe("independent Workflow (QuickJS and faux/local runners only)", () => {
	it("returns immediately and accepts conversation while an isolated child is pending", async () => {
		const { harness, executions } = await setup();
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.waitForIdle();
		harness.setResponses([fauxAssistantMessage("No waiting for Workflow.")]);
		await harness.session.prompt("Another question, MAIN_SECRET");
		expect(executions[0].options.request.prompt).not.toContain("MAIN_SECRET");
		expect(executions[0].options.signal.aborted).toBe(false);
		executions[0].complete("isolated findings");
		await ready(harness, started.workflow.id);
		const result = await call(harness, { action: "result", id: started.workflow.id });
		expect(JSON.stringify(result.details)).toContain("isolated findings");
		expect(result.usage?.totalTokens).toBe(12);
		expect((await call(harness, { action: "result", id: started.workflow.id })).usage).toBeUndefined();
	});

	it("keeps results active until retrieval and explicit processing acknowledgement; retains history", async () => {
		const { harness, executions } = await setup();
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("ready");
		await ready(harness, started.workflow.id);
		expect(
			(await call(harness, { action: "acknowledge", id: started.workflow.id, summary: "too soon" })).isError,
		).toBe(true);
		expect(JSON.stringify((await call(harness, { action: "list" })).details)).toContain(started.workflow.id);
		await call(harness, { action: "result", id: started.workflow.id });
		await call(harness, {
			action: "acknowledge",
			id: started.workflow.id,
			summary: "Read findings and reported them to the user",
		});
		expect((await call(harness, { action: "list" })).details).toEqual({ workflows: [] });
		expect(JSON.stringify((await call(harness, { action: "list", include_archived: true })).details)).toContain(
			"archived",
		);
		expect(readFileSync(started.logPath, "utf8")).toContain("Agent completed");
		expect(readFileSync(started.resultPath, "utf8")).toContain("Read findings");
		expect((await call(harness, { action: "resume", id: started.workflow.id })).isError).toBe(true);
	});

	it("limits parallel children and supports ordered pipeline results and phases", async () => {
		const { harness, executions } = await setup({ limits: { concurrency: 2 } });
		const started = await launch(
			harness,
			"await phase('Explore'); const found = await pipeline(['a','b','c'], item => agent(item,{role:'reviewer'})); await phase('Summary'); return found.map(r=>r.output);",
		);
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		expect(executions.map((execution) => execution.options.request.prompt)).toEqual(["a", "b"]);
		executions[1].complete("B");
		await vi.waitFor(() => expect(executions).toHaveLength(3));
		executions[2].complete("C");
		executions[0].complete("A");
		await ready(harness, started.workflow.id);
		const result = await call(harness, { action: "result", id: started.workflow.id });
		expect(JSON.stringify(result.details)).toContain('[\\"A\\",\\"B\\",\\"C\\"]');
		expect(JSON.stringify(result.details)).toContain("Summary");
	});

	it("pause blocks queued children; resume does not rerun completed ones", async () => {
		const { harness, executions } = await setup({ limits: { concurrency: 1 } });
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		await harness.session.prompt(`/workflow pause ${started.workflow.id}`);
		executions[0].complete("one");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(executions).toHaveLength(1);
		await harness.session.prompt(`/workflow resume ${started.workflow.id}`);
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		expect(executions[1].options.request.prompt).toBe("two");
		executions[1].complete("two");
		await ready(harness, started.workflow.id);
		expect((await call(harness, { action: "resume", id: started.workflow.id })).isError).toBe(true);
	});

	it("stop cancels running and queued children, preserves a stopped result and emits no ready follow-up", async () => {
		const { harness, executions, notices } = await setup({ limits: { concurrency: 1 }, notifyModel: true });
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		await harness.session.prompt(`/workflow stop ${started.workflow.id}`);
		expect(executions[0].options.signal.aborted).toBe(true);
		expect(executions).toHaveLength(1);
		expect(JSON.stringify((await call(harness, { action: "status", id: started.workflow.id })).details)).toContain(
			"stopped",
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notices.some((text) => text.includes("tokens"))).toBe(false);
	});

	it("Escape pauses event-driven model continuation, not the Workflow", async () => {
		const { harness, executions, notices } = await setup({ notifyModel: true });
		await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		await harness.session.extensionRunner.emit({ type: "agent_settled", aborted: true });
		harness.appendResponses([fauxAssistantMessage("Must not consume after abort")]);
		executions[0].complete("after abort");
		await vi.waitFor(() => expect(notices.some((text) => text.includes("tokens"))).toBe(true));
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("ready events can trigger one real faux follow-up without polling requests", async () => {
		const { harness, executions } = await setup({ notifyModel: true });
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		let eventSeen = false;
		harness.appendResponses([
			(context) => {
				eventSeen =
					JSON.stringify(context.messages).includes(started.workflow.id) &&
					JSON.stringify(context.messages).includes("Workflow results ready");
				return fauxAssistantMessage("Result received; review before ack.");
			},
		]);
		executions[0].complete("done");
		await vi.waitFor(() => expect(eventSeen).toBe(true));
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it.each([
		"return process.cwd();",
		"return await tools.bash({command:'bad'});",
		"return await models.getAvailableOfType('chat');",
	])("script cannot reach unrelated host capabilities: %s", async (code) => {
		const { harness, executions } = await setup();
		const started = await launch(harness, code);
		await ready(harness, started.workflow.id);
		expect(executions).toHaveLength(0);
		expect(JSON.stringify((await call(harness, { action: "result", id: started.workflow.id })).details)).toContain(
			"failed",
		);
	});

	it("validates write policy and allows the launch permission hook to block before execution", async () => {
		const { harness, executions } = await setup({}, (pi) => {
			pi.on("tool_call", (event) =>
				event.toolName === "workflow" && event.input.action === "start"
					? { block: true, reason: "No launch approval" }
					: undefined,
			);
		});
		const result = await call(harness, { action: "start", label: "blocked", cwd: harness.tempDir, code: "return 1" });
		expect(result.isError).toBe(true);
		expect(executions).toHaveLength(0);
		const other = await setup();
		expect(
			(
				await call(other.harness, {
					action: "start",
					label: "write",
					cwd: other.harness.tempDir,
					code: "return 1",
					write_access: true,
				})
			).isError,
		).toBe(true);
	});

	it("enforces total token and agent-count limits even if the script catches a bridge error", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 10 } });
		const started = await launch(harness, "try { await agent('budget'); } catch {} return 'caught';");
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("too many", 20);
		await ready(harness, started.workflow.id);
		expect(JSON.stringify((await call(harness, { action: "result", id: started.workflow.id })).details)).toContain(
			"token budget exhausted",
		);
		const counted = await setup({ limits: { maxAgents: 1 } });
		const second = await launch(counted.harness, "await agent('first'); return await agent('second');");
		await vi.waitFor(() => expect(counted.executions).toHaveLength(1));
		counted.executions[0].complete("one");
		await ready(counted.harness, second.workflow.id);
		expect(counted.executions).toHaveLength(1);
		expect(
			JSON.stringify((await call(counted.harness, { action: "result", id: second.workflow.id })).details),
		).toContain("agent count limit");
	});

	it("deadline interrupts pure script loops and shutdown suppresses pending notifications", async () => {
		const { harness } = await setup({ limits: { timeoutSeconds: 1 } });
		const started = await launch(harness, "while(true) {}");
		await ready(harness, started.workflow.id);
		expect(JSON.stringify((await call(harness, { action: "result", id: started.workflow.id })).details)).toContain(
			"deadline expired",
		);
		const other = await setup({ notifyModel: true });
		await launch(other.harness);
		await vi.waitFor(() => expect(other.executions).toHaveLength(1));
		await other.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(other.executions[0].options.signal.aborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(other.notices).toEqual([]);
	});

	it("restores interrupted workflows as unknown results, never resumes them or routes through Ultra", async () => {
		const { harness, executions } = await setup();
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		const restored = new WorkflowManager({
			storageRoot: dirname(dirname(started.logPath)),
			sessionId: harness.sessionManager.getSessionId(),
		});
		extraManagers.push(restored);
		expect(restored.get(started.workflow.id)).toMatchObject({ status: "awaiting_result", outcome: "unknown" });
		expect(() => restored.resume(started.workflow.id)).toThrow("never restarted");
		await expect(restored.stop(started.workflow.id)).rejects.toThrow("previous runtime");
		let routes = 0;
		const routed = await setup({}, (pi) =>
			pi.registerVirtualModel({
				provider: "workflow-test-ultra",
				id: "router",
				name: "Ultra test router",
				route: () => {
					routes++;
					throw new Error("Must not route a Workflow child");
				},
			}),
		);
		expect(
			(
				await call(routed.harness, {
					action: "start",
					label: "router",
					cwd: routed.harness.tempDir,
					code: "return 1",
					provider: "workflow-test-ultra",
					model: "router",
				})
			).isError,
		).toBe(true);
		expect(routes).toBe(0);
	});

	it("renders a narrow Workflow widget and removes it only after acknowledgement", async () => {
		initTheme("dark", false);
		const { harness, executions } = await setup();
		const widths: number[] = [];
		let widgetVisible = false;
		const ui = createTestUiContext({
			setWidget: (_key, content) => {
				widgetVisible = content !== undefined;
				if (typeof content === "function")
					widths.push(
						...content({} as Parameters<typeof content>[0], ui.theme)
							.render(25)
							.map(visibleWidth),
					);
			},
		});
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui });
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("中文结果");
		await ready(harness, started.workflow.id);
		expect(widgetVisible).toBe(true);
		expect(widths.length).toBeGreaterThan(0);
		expect(widths.every((width) => width <= 25)).toBe(true);
		await call(harness, { action: "result", id: started.workflow.id });
		await call(harness, { action: "acknowledge", id: started.workflow.id, summary: "已处理结果" });
		expect(widgetVisible).toBe(false);
	});

	it.each(["worker", "scout"] as const)("real child write policy for %s", async (role) => {
		const { harness, release } = await actualSetup({ allowWrites: true });
		const response = await call(harness, {
			action: "start",
			label: "write policy",
			cwd: harness.tempDir,
			code: `return await agent('Try writing owned.txt',{role:'${role}'});`,
			write_access: true,
		});
		const started = response.details as { workflow: { id: string }; resultPath: string };
		resultPaths.set(started.workflow.id, started.resultPath);
		harness.setResponses([
			(context) => {
				const tools = getCurrentTools(context.messages).map((tool) => tool.name);
				expect(tools.includes("write")).toBe(role === "worker");
				return fauxAssistantMessage(fauxToolCall("write", { path: "owned.txt", content: "owned change" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Policy checked"),
		]);
		release();
		await ready(harness, started.workflow.id);
		if (role === "worker") expect(readFileSync(join(harness.tempDir, "owned.txt"), "utf8")).toBe("owned change");
		else expect(() => readFileSync(join(harness.tempDir, "owned.txt"))).toThrow();
	});

	it("real child model loop enforces its turn limit without consuming another response", async () => {
		const { harness, release } = await actualSetup({ limits: { maxTurns: 1 } });
		writeFileSync(join(harness.tempDir, "fixture.txt"), "local file");
		const started = await launch(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Must not request this turn"),
		]);
		release();
		await ready(harness, started.workflow.id);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(readFileSync(started.resultPath, "utf8")).toContain("Child turn limit reached");
	});

	it("runs real isolated Agent loops with faux responses and enforces workspace/tool policy", async () => {
		const { harness, release } = await actualSetup();
		writeFileSync(join(harness.tempDir, "fixture.txt"), "local file");
		const started = await launch(harness, "return await agent('Read fixture.txt, then summarize', {role:'scout'});");
		let isolated = false;
		harness.setResponses([
			(context) => {
				isolated = !JSON.stringify(context.messages).includes("Handle Workflow operation");
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
				return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("local file");
				return fauxAssistantMessage("Verified isolated child");
			},
		]);
		release();
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		await ready(harness, started.workflow.id);
		expect(isolated).toBe(true);
		expect(JSON.stringify((await call(harness, { action: "result", id: started.workflow.id })).details)).toContain(
			"Verified isolated child",
		);
		expect(() => workspacePath(harness.tempDir, "../outside")).toThrow("outside");
		const symlink = join(harness.tempDir, "escape");
		symlinkSync(dirname(harness.tempDir), symlink);
		expect(() => workspacePath(harness.tempDir, "escape/new.txt")).toThrow("outside");
	});
});

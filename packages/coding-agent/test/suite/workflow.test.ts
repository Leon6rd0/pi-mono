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
	type ModelRequestEstimate,
} from "../../examples/extensions/workflow/types.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const extraManagers: WorkflowManager[] = [];
const directories: string[] = [];
const resultPaths = new Map<string, string>();
const mockEstimate = {
	estimatedInputTokens: 0,
	maxOutputTokens: 1,
	marginTokens: 0,
	estimator: "trusted_host" as const,
};
interface Execution {
	options: ChildOptions;
	requestId: string;
	complete(output: string, tokens?: number): void;
}
async function setup(
	options: WorkflowOptions = {},
	gate?: (pi: ExtensionAPI) => void,
	estimate: ModelRequestEstimate = mockEstimate,
) {
	const executions: Execution[] = [];
	const notices: string[] = [];
	const storageRoot = mkdtempSync(join(tmpdir(), "pi-workflow-"));
	directories.push(storageRoot);
	const controlled: ChildRunner = async (options) => {
		const requestId = await options.beforeRequest(estimate);
		options.signal.throwIfAborted();
		options.onRequestDispatched?.(requestId);
		return new Promise<ChildResult>((resolve, reject) => {
			const abort = () => reject(new Error("child aborted"));
			options.signal.addEventListener("abort", abort, { once: true });
			executions.push({
				options,
				requestId,
				complete: (output, tokens = 12) => {
					options.signal.removeEventListener("abort", abort);
					const usage = emptyUsage();
					usage.totalTokens = tokens;
					usage.output = tokens;
					options.onUsage(usage, undefined, requestId);
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

	it("exposes live per-child and per-request reported tokens while another child is still pending", async () => {
		const { harness, executions } = await setup();
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		executions[0].complete("first", 17);
		const status = await call(harness, { action: "status", id: started.workflow.id });
		expect(status.details).toMatchObject({
			workflow: {
				status: "running",
				usage: { totalTokens: 17 },
				agents: [
					{
						usage: { totalTokens: 17 },
						requests: [{ status: "reported", source: "request_gate", usage: { totalTokens: 17 } }],
					},
					{ usage: { totalTokens: 0 }, requests: [{ status: "in_flight", source: "request_gate" }] },
				],
			},
		});
		expect(status.usage).toBeUndefined(); // Inspecting must not bill the parent twice.
		executions[1].complete("second", 23);
		await ready(harness, started.workflow.id);
		const result = await call(harness, { action: "result", id: started.workflow.id });
		expect(result.usage?.totalTokens).toBe(40);
	});

	it("keeps separate model-request/cache counters rather than merging a child's requests", async () => {
		const { harness } = await setup({
			runChild: async (options) => {
				const firstId = await options.beforeRequest(mockEstimate);
				options.onRequestDispatched?.(firstId);
				const first = { ...emptyUsage(), input: 10, output: 5, cacheRead: 100, totalTokens: 115 };
				options.onUsage(first, undefined, firstId);
				const secondId = await options.beforeRequest(mockEstimate);
				options.onRequestDispatched?.(secondId);
				const second = { ...emptyUsage(), input: 20, output: 10, totalTokens: 30 };
				options.onUsage(second, undefined, secondId);
				return { output: "two responses", usage: { ...emptyUsage(), totalTokens: 145 }, turns: 2 };
			},
		});
		const started = await launch(harness);
		await ready(harness, started.workflow.id);
		const result = await call(harness, { action: "result", id: started.workflow.id });
		expect(result.details).toMatchObject({
			workflow: {
				usage: { totalTokens: 145, input: 30, output: 15, cacheRead: 100 },
				agents: [
					{
						usage: { totalTokens: 145 },
						requests: [
							{ id: `${started.workflow.id}/agent-1/request-1`, usage: { totalTokens: 115, cacheRead: 100 } },
							{ id: `${started.workflow.id}/agent-1/request-2`, usage: { totalTokens: 30 } },
						],
					},
				],
			},
		});
	});

	it("distinguishes a trusted confirmed zero report from unknown zero defaults", async () => {
		const { harness } = await setup({
			runChild: async (options) => {
				const requestId = await options.beforeRequest(mockEstimate);
				options.onRequestDispatched?.(requestId);
				options.onUsage(emptyUsage(), { reported: true }, requestId);
				return { output: "known zero", usage: emptyUsage(), turns: 1 };
			},
		});
		const started = await launch(harness);
		await ready(harness, started.workflow.id);
		expect((await call(harness, { action: "result", id: started.workflow.id })).details).toMatchObject({
			workflow: { agents: [{ turns: 1, requests: [{ status: "reported", usage: { totalTokens: 0 } }] }] },
		});
	});

	it("persists queued children immediately and preserves dispatch attempts after stopping", async () => {
		const { harness, executions } = await setup({ limits: { concurrency: 1 } });
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() =>
			expect(JSON.parse(readFileSync(started.resultPath, "utf8")).agents).toMatchObject([
				{ status: "running", turns: 1, requests: [{ dispatchedAt: expect.any(Number) }] },
				{ status: "queued", turns: 0, requests: [] },
			]),
		);
		expect(executions).toHaveLength(1);
		await harness.session.prompt(`/workflow stop ${started.workflow.id}`);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).agents).toMatchObject([
			{ status: "stopped", turns: 1, requests: [{ status: "unknown", dispatchedAt: expect.any(Number) }] },
			{ status: "stopped", turns: 0, requests: [] },
		]);
	});

	it("reserves before dispatch and waits for a real settlement instead of sharing remaining tokens", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 100 } }, undefined, {
			...mockEstimate,
			estimatedInputTokens: 69,
		});
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(JSON.parse(readFileSync(started.resultPath, "utf8")).agents).toHaveLength(2));
		expect(executions).toHaveLength(1);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).budget).toMatchObject({
			reservedTokens: 70,
			availableTokens: 30,
		});
		executions[0].complete("first", 10);
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).budget).toMatchObject({
			reservedTokens: 70,
			availableTokens: 20,
			usage: { totalTokens: 10 },
		});
		executions[1].complete("second", 10);
		await ready(harness, started.workflow.id);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).budget).toMatchObject({
			reservedTokens: 0,
			usage: { totalTokens: 20 },
		});
	});

	it("fails an unaffordable admission before any provider handoff even if the script catches it", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 50 } }, undefined, {
			...mockEstimate,
			estimatedInputTokens: 69,
		});
		const started = await launch(harness, "try { await agent('too large'); } catch {} return 'caught';");
		await ready(harness, started.workflow.id);
		expect(executions).toHaveLength(0);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "failed",
			usage: { totalTokens: 0 },
			agents: [{ turns: 0, requests: [] }],
		});
		expect(readFileSync(started.resultPath, "utf8")).toContain("budget exhausted at workflow admission");
	});

	it("unknown usage keeps its debit and wakes a blocked admission into explicit failure, not another call", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 100 } }, undefined, {
			...mockEstimate,
			estimatedInputTokens: 69,
		});
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("unreported", 0);
		await ready(harness, started.workflow.id);
		expect(executions).toHaveLength(1);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "failed",
			budget: { reservedTokens: 70, unknownTokens: 70, usage: { totalTokens: 0 } },
		});
	});

	it("refunds only a confirmed unsent admission on failure", async () => {
		const { harness } = await setup({
			limits: { maxTotalTokens: 100 },
			runChild: async (options) => {
				await options.beforeRequest({ ...mockEstimate, estimatedInputTokens: 69 });
				throw new Error("local preparation failed before handoff");
			},
		});
		const started = await launch(harness);
		await ready(harness, started.workflow.id);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			budget: { reservedTokens: 0, availableTokens: 100 },
			agents: [{ turns: 0, requests: [{ status: "not_sent" }] }],
		});
	});

	it("settles by request ID once and keeps late usage attached to its original phase", async () => {
		const { harness, executions } = await setup();
		const started = await launch(
			harness,
			"await phase('first'); await agent('one'); await phase('second'); return await agent('two');",
		);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("first with missing metrics", 0);
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		const late = { ...emptyUsage(), cacheRead: 12, totalTokens: 12 };
		executions[0].options.onUsage(late, undefined, executions[0].requestId);
		executions[0].options.onUsage(late, undefined, executions[0].requestId);
		executions[1].complete("second", 10);
		await ready(harness, started.workflow.id);
		const record = JSON.parse(readFileSync(started.resultPath, "utf8"));
		expect(record.usage.totalTokens).toBe(22);
		expect(record.budget.phases).toMatchObject([
			{ id: "phase-1", usage: { totalTokens: 0 } },
			{ id: "phase-2", usage: { totalTokens: 12 } },
			{ id: "phase-3", usage: { totalTokens: 10 } },
		]);
	});

	it.each([
		"await phase('limited',{maxTotalTokens:50}); return await agent('one');",
		"return await agent('one',{maxTotalTokens:50});",
	])("enforces explicit phase/child allocations before calls: %s", async (code) => {
		const { harness, executions } = await setup({}, undefined, { ...mockEstimate, estimatedInputTokens: 69 });
		const started = await launch(harness, code);
		await ready(harness, started.workflow.id);
		expect(executions).toHaveLength(0);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).outcome).toBe("failed");
	});

	it("retains a bounded checkpoint and unknown mutation before an over-budget cancellation", async () => {
		const { harness } = await setup({
			limits: { maxTotalTokens: 100 },
			runChild: async (options) => {
				const id = await options.beforeRequest({ ...mockEstimate, estimatedInputTokens: 69 });
				options.onRequestDispatched?.(id);
				options.onProgress?.({
					partial: true,
					output: "finding retained before cancel",
					outputTruncated: false,
					operations: [{ id: "w1", name: "write", path: "owned.txt", mutation: true, status: "started" }],
					droppedOperations: 0,
					updatedAt: Date.now(),
				});
				options.onUsage({ ...emptyUsage(), output: 120, totalTokens: 120 }, undefined, id);
				options.signal.throwIfAborted();
				return { output: "must not accept", usage: emptyUsage(), turns: 1 };
			},
		});
		const started = await launch(harness);
		await ready(harness, started.workflow.id);
		const result = await call(harness, {
			action: "result",
			id: started.workflow.id,
			agent_id: `${started.workflow.id}/agent-1`,
		});
		expect(result.details).toMatchObject({
			workflow: {
				outcome: "failed",
				agent: {
					progress: {
						partial: true,
						output: "finding retained before cancel",
						operations: [{ mutation: true, status: "unknown" }],
					},
				},
			},
		});
	});

	it("cancels on actual plus outstanding overcommit before reported actual alone exceeds the limit", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 1000 } }, undefined, {
			...mockEstimate,
			estimatedInputTokens: 399,
		});
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		executions[0].complete("actual exceeded estimate", 700);
		await ready(harness, started.workflow.id);
		expect(executions[1].options.signal.aborted).toBe(true);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "failed",
			budget: {
				usage: { totalTokens: 700 },
				reservedTokens: 400,
				unknownTokens: 400,
				overspentTokens: 0,
				overcommittedTokens: 100,
			},
			agents: [{ requests: [{ underestimatedTokens: 300 }] }, { requests: [{ status: "unknown" }] }],
		});
	});

	it("rechecks pause after a competing request settles and releases admission balance", async () => {
		const { harness, executions } = await setup({ limits: { maxTotalTokens: 100 } }, undefined, {
			...mockEstimate,
			estimatedInputTokens: 69,
		});
		const started = await launch(harness, "return await parallel([()=>agent('one'),()=>agent('two')]);");
		await vi.waitFor(() => expect(JSON.parse(readFileSync(started.resultPath, "utf8")).agents).toHaveLength(2));
		await harness.session.prompt(`/workflow pause ${started.workflow.id}`);
		executions[0].complete("released balance", 10);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(executions).toHaveLength(1);
		await harness.session.prompt(`/workflow resume ${started.workflow.id}`);
		await vi.waitFor(() => expect(executions).toHaveLength(2));
		executions[1].complete("done", 10);
		await ready(harness, started.workflow.id);
	});

	it("requires explicit IDs for late observations instead of assigning them to the newest request", async () => {
		const { harness } = await setup({
			runChild: async (options) => {
				const first = await options.beforeRequest(mockEstimate);
				options.onRequestDispatched?.(first);
				options.onUsage(emptyUsage(), undefined, first);
				const second = await options.beforeRequest(mockEstimate);
				options.onRequestDispatched?.(second);
				const late = { ...emptyUsage(), input: 20, totalTokens: 20 };
				expect(() => Reflect.apply(options.onUsage, undefined, [late])).toThrow("admitted request ID");
				options.onUsage(late, undefined, first);
				options.onUsage(late, undefined, first);
				expect(() => options.onUsage({ ...late, totalTokens: 21 }, undefined, first)).toThrow("Conflicting usage");
				options.onUsage(emptyUsage(), { reported: true }, second);
				return { output: "correct request attribution", usage: late, turns: 2 };
			},
		});
		const started = await launch(harness);
		await ready(harness, started.workflow.id);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "completed",
			usage: { totalTokens: 20 },
			agents: [
				{
					requests: [
						{ status: "reported", usage: { totalTokens: 20 } },
						{ status: "reported", usage: { totalTokens: 0 } },
					],
				},
			],
		});
	});

	it("late usage preserves read/archive ownership and exposes corrections without billing twice", async () => {
		const { harness, executions } = await setup();
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("ready but metrics unknown", 0);
		await ready(harness, started.workflow.id);
		const initial = await call(harness, { action: "result", id: started.workflow.id });
		expect(initial.usage?.totalTokens).toBe(0);
		expect(initial.details).toMatchObject({
			usageObservation: { completeness: "partial", unknownRequests: 1, returnedToParentTokens: 0 },
		});
		await call(harness, {
			action: "acknowledge",
			id: started.workflow.id,
			summary: "Processed known partial accounting",
		});
		executions[0].options.onUsage(
			{ ...emptyUsage(), input: 12, totalTokens: 12 },
			undefined,
			executions[0].requestId,
		);
		const late = await call(harness, { action: "result", id: started.workflow.id });
		expect(late.usage).toBeUndefined();
		expect(late.details).toMatchObject({
			workflow: { status: "archived", usage: { totalTokens: 12 } },
			usageObservation: {
				completeness: "complete",
				unknownRequests: 0,
				returnedToParentTokens: 0,
				lateReportedTokens: 12,
			},
		});
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			status: "archived",
			resultRead: true,
			usageReported: true,
			acknowledgement: "Processed known partial accounting",
		});
		expect((await call(harness, { action: "list" })).details).toEqual({ workflows: [] });
	});

	it.each([100, 13000])(
		"command result labels display truncation without consuming model-tool usage (%i chars)",
		async (length) => {
			const { harness, executions, notices } = await setup();
			const started = await launch(harness);
			await vi.waitFor(() => expect(executions).toHaveLength(1));
			executions[0].complete(`${"x".repeat(length)}RETAINED_TAIL`);
			await ready(harness, started.workflow.id);
			await harness.session.prompt(`/workflow result ${started.workflow.id}`);
			const display = notices.find((text) => text.includes(`"id": "${started.workflow.id}"`));
			expect(display).toBeDefined();
			if (length > 12000) {
				expect(display).toContain("Display truncated; full retained record:");
				expect(display).toContain(started.resultPath);
				expect(display).not.toContain("RETAINED_TAIL");
			} else {
				expect(display).not.toContain("Display truncated");
				expect(display).toContain("RETAINED_TAIL");
			}
			expect(readFileSync(started.resultPath, "utf8")).toContain("RETAINED_TAIL");
			const result = await call(harness, { action: "result", id: started.workflow.id });
			expect(result.usage?.totalTokens).toBe(12);
			expect(result.details).toMatchObject({ workflow: { deliveryComplete: true } });
		},
	);

	it("exposes child and script output truncation instead of implying complete delivery", async () => {
		const { harness, executions } = await setup();
		const started = await launch(
			harness,
			"const child=await agent('one'); if(!child.outputTruncated) throw Error('missing flag'); return 'x'.repeat(70000);",
		);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		executions[0].complete("x".repeat(17000));
		await ready(harness, started.workflow.id);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "completed",
			deliveryComplete: false,
			resultTruncated: true,
			agents: [{ outputTruncated: true, outputOriginalLength: 17000 }],
		});
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).resultOriginalLength).toBeUndefined(); // Codemode already truncated; no invented original length.
		const result = await call(harness, { action: "result", id: started.workflow.id });
		expect(result.details).toMatchObject({
			workflow: { deliveryComplete: false, resultTruncated: true, agents: [{ outputTruncated: true }] },
		});
	});

	it("script success with a caught child failure is not a complete delivery", async () => {
		const { harness } = await setup({
			runChild: async () => {
				throw new Error("child failed locally");
			},
		});
		const started = await launch(harness, "try { await agent('one'); } catch {} return 'script returned';");
		await ready(harness, started.workflow.id);
		expect(JSON.parse(readFileSync(started.resultPath, "utf8"))).toMatchObject({
			outcome: "completed",
			deliveryComplete: false,
			agents: [{ status: "failed" }],
		});
	});

	it("real child checkpoints its response before reported usage triggers cancellation", async () => {
		const { harness, release } = await actualSetup({ limits: { maxTotalTokens: 10000, maxOutputTokens: 100 } });
		const started = await launch(harness);
		// Faux recomputes usage and does not enforce maxTokens. Use its real estimated
		// output count to model provider overshoot; setting response.usage is overwritten.
		harness.setResponses([
			fauxAssistantMessage(`partial facts before token stop\n${"x".repeat(48000)}\nretained tail`),
		]);
		release();
		await ready(harness, started.workflow.id);
		const record = JSON.parse(readFileSync(started.resultPath, "utf8"));
		expect(record).toMatchObject({
			outcome: "failed",
			agents: [{ turns: 1, progress: { partial: true, outputTruncated: true } }],
		});
		expect(record.usage.totalTokens).toBeGreaterThan(10000);
		expect(record.agents[0].requests[0].reservedTokens).toBeLessThanOrEqual(10000);
		expect(record.agents[0].progress.output).toMatch(/^partial facts before token stop/);
		expect(record.agents[0].progress.output).toMatch(/retained tail$/);
		expect(record.agents[0].progress.output.length).toBeLessThanOrEqual(8192);
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
		const stopped = await call(harness, { action: "status", id: started.workflow.id });
		expect(stopped.details).toMatchObject({
			workflow: { outcome: "stopped", agents: [{ requests: [{ status: "unknown" }] }, { requests: [] }] },
		});
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
		executions[0].options.onProgress?.({
			partial: true,
			output: "saved observation",
			outputTruncated: false,
			operations: [{ id: "w1", name: "write", mutation: true, status: "started" }],
			droppedOperations: 0,
			updatedAt: Date.now(),
		});
		const before = JSON.parse(readFileSync(started.resultPath, "utf8"));
		const restored = new WorkflowManager({
			storageRoot: dirname(dirname(started.logPath)),
			sessionId: harness.sessionManager.getSessionId(),
		});
		extraManagers.push(restored);
		expect(restored.get(started.workflow.id)).toMatchObject({
			status: "awaiting_result",
			outcome: "unknown",
			budget: {
				reservedTokens: before.budget.reservedTokens,
				unknownTokens: before.budget.reservedTokens,
				availableTokens: before.budget.availableTokens,
				usage: before.budget.usage,
				phases: [{ unknownTokens: 1, reservedTokens: 1 }],
				agents: [{ unknownTokens: 1, reservedTokens: 1 }],
			},
			agents: [
				{
					requests: [{ status: "unknown" }],
					budget: { unknownTokens: 1, reservedTokens: 1 },
					progress: { output: "saved observation", operations: [{ status: "unknown" }] },
				},
			],
		});
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
		const rows: string[] = [];
		const statuses: string[] = [];
		let widgetVisible = false;
		const ui = createTestUiContext({
			setStatus: (_key, text) => {
				if (text) statuses.push(text);
			},
			setWidget: (_key, content) => {
				widgetVisible = content !== undefined;
				if (typeof content === "function") {
					const widget = content({} as Parameters<typeof content>[0], ui.theme);
					widths.push(...widget.render(25).map(visibleWidth));
					rows.push(...widget.render(180));
				}
			},
		});
		await harness.session.bindExtensions({ mode: "tui", uiContext: ui });
		const started = await launch(harness);
		await vi.waitFor(() => expect(executions).toHaveLength(1));
		expect(rows.join("\n")).toContain("1 in-flight");
		expect(statuses.join("\n")).toContain("0 tok reported");
		executions[0].complete("中文结果");
		await ready(harness, started.workflow.id);
		expect(rows.join("\n")).toContain("12 tok reported");
		expect(rows.join("\n")).toContain("req 1 reported 12 tok");
		expect(statuses.join("\n")).toContain("12 tok reported");
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
		expect(JSON.parse(readFileSync(started.resultPath, "utf8")).agents).toMatchObject([
			{ turns: 1, requests: [{ dispatchedAt: expect.any(Number) }] },
		]);
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

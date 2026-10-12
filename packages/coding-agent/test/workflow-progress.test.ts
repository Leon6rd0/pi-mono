import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChildProgressTracker } from "../examples/extensions/workflow/progress.ts";

const start = (id: string, name = "read"): AgentEvent => ({
	type: "tool_execution_start",
	toolCallId: id,
	toolName: name,
	args: { path: "owned.txt" },
});

describe("Bounded child partial progress", () => {
	it("retains completed assistant evidence and ignores synthetic empty failures", () => {
		const tracker = new ChildProgressTracker();
		tracker.observe({ type: "message_end", message: fauxAssistantMessage("Observation, not acceptance") });
		tracker.observe({ type: "message_end", message: fauxAssistantMessage("", { stopReason: "error" }) });
		expect(tracker.snapshot()).toMatchObject({
			partial: true,
			output: "Observation, not acceptance",
			outputTruncated: false,
		});
	});
	it("records actual tool outcomes without calling them verified test/file-mutation success", () => {
		const tracker = new ChildProgressTracker();
		tracker.observe(start("w1", "write"));
		tracker.observe({
			type: "tool_execution_end",
			toolCallId: "w1",
			toolName: "write",
			isError: true,
			result: { content: [{ type: "text", text: "write failed; side effects may remain" }], details: undefined },
		});
		expect(tracker.snapshot().operations).toMatchObject([
			{ mutation: true, status: "failed", path: "owned.txt", result: "write failed; side effects may remain" },
		]);
	});
	it("keeps unresolved mutations unknown after interruption, not rolled back", () => {
		const tracker = new ChildProgressTracker();
		tracker.observe(start("w1", "edit"));
		expect(tracker.interrupt()).toBe(true);
		expect(tracker.interrupt()).toBe(false);
		expect(tracker.snapshot().operations[0]).toMatchObject({ mutation: true, status: "unknown" });
	});
	it("bounds output, operation count and tool excerpts with explicit truncation", () => {
		const tracker = new ChildProgressTracker();
		tracker.observe({ type: "message_end", message: fauxAssistantMessage("x".repeat(20000)) });
		for (let i = 0; i < 70; i++) tracker.observe(start(`r${i}`));
		tracker.observe({
			type: "tool_execution_end",
			toolCallId: "r69",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: "x".repeat(10000) }], details: undefined },
		});
		const snapshot = tracker.snapshot();
		expect(snapshot.output.length).toBeLessThanOrEqual(8192);
		expect(snapshot.outputTruncated).toBe(true);
		expect(snapshot.operations).toHaveLength(64);
		expect(snapshot.droppedOperations).toBe(6);
		expect(snapshot.operations[63].result!.length).toBeLessThanOrEqual(2000);
		expect(snapshot.operations[63].truncated).toBe(true);
	});
	it.each([null, {}, { content: [null, 12, { type: "image" }, { type: "text", text: 1 }] }])(
		"tolerates untyped tool results without losing the observed outcome: %j",
		(result) => {
			const tracker = new ChildProgressTracker();
			tracker.observe(start("r1"));
			expect(() =>
				tracker.observe({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", isError: true, result }),
			).not.toThrow();
			expect(tracker.snapshot().operations[0]).toMatchObject({ status: "failed", result: "" });
		},
	);

	it("snapshot mutation cannot alter the retained execution point", () => {
		const tracker = new ChildProgressTracker();
		tracker.observe(start("r1"));
		tracker.snapshot().operations[0].status = "completed";
		expect(tracker.snapshot().operations[0].status).toBe("started");
	});
});

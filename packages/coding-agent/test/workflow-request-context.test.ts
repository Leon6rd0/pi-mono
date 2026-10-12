import { fauxAssistantMessage, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { estimateWorkflowRequest } from "../examples/extensions/workflow/request-context.ts";
import { emptyUsage } from "../examples/extensions/workflow/types.ts";

const context = (text: string): TranscriptContext =>
	normalizeContext({ messages: [{ role: "system", content: text, timestamp: 1 }] });

describe("Workflow request context estimation", () => {
	it("estimates the actual system prompt/replay and reserves an explicit margin", () => {
		const estimate = estimateWorkflowRequest(context("a".repeat(3500)), 100, 10000);
		expect(estimate).toMatchObject({
			estimatedInputTokens: 1004,
			maxOutputTokens: 100,
			marginTokens: 256,
			estimator: "context_usage_and_chars",
		});
	});
	it("counts cached input from an applicable previous response without counting cumulative workflow usage", () => {
		const response = fauxAssistantMessage("answer");
		response.timestamp = 2;
		response.usage = { ...emptyUsage(), input: 100, output: 10, cacheRead: 1000, totalTokens: 1110 };
		const estimate = estimateWorkflowRequest(
			normalizeContext({
				messages: [...context("instructions").messages, response, { role: "user", content: "next", timestamp: 3 }],
			}),
			100,
			10000,
		);
		expect(estimate.estimatedInputTokens).toBeGreaterThanOrEqual(1110);
	});
	it("includes tool declarations and tool-result replay rather than just visible user text", () => {
		const plain = estimateWorkflowRequest(context("instructions"), 100, 10000);
		const withTools = normalizeContext({
			messages: [
				{
					role: "system",
					content: "instructions",
					timestamp: 1,
					toolsAdded: [
						{ name: "read", description: "d".repeat(3500), parameters: Type.Object({ path: Type.String() }) },
					],
				},
				{
					role: "toolResult",
					toolCallId: "r1",
					toolName: "read",
					content: [{ type: "text", text: "r".repeat(3500) }],
					isError: false,
					timestamp: 2,
				},
			],
		});
		const estimate = estimateWorkflowRequest(withTools, 100, 10000);
		expect(estimate.estimatedInputTokens - plain.estimatedInputTokens).toBeGreaterThan(2000);
		expect(estimate.marginTokens).toBe(Math.ceil(estimate.estimatedInputTokens * 0.2));
	});
	it("does not use omitted aborted-response usage as the next request's context", () => {
		const aborted = fauxAssistantMessage("not replayed", { stopReason: "aborted", timestamp: 2 });
		aborted.usage = { ...emptyUsage(), input: 100000, totalTokens: 100000 };
		const estimate = estimateWorkflowRequest(
			normalizeContext({ messages: [...context("instructions").messages, aborted] }),
			100,
			10000,
		);
		expect(estimate.estimatedInputTokens).toBeLessThan(100);
	});
	it("rejects an estimated request that cannot fit the physical window before admission/provider dispatch", () => {
		expect(() => estimateWorkflowRequest(context("a".repeat(3500)), 100, 1200)).toThrow("physical model window");
	});
	it.each([0, -1, 0.5, Number.NaN])("rejects invalid physical output/window limit %s", (limit) => {
		expect(() => estimateWorkflowRequest(context("x"), limit, 10000)).toThrow("physical-model");
		expect(() => estimateWorkflowRequest(context("x"), 10, limit)).toThrow("physical-model");
	});
});

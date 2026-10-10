import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import { estimateContextTokens, estimateMessageTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it.each(["aborted", "error"] as const)("does not reserve output capacity for %s fragments", (stopReason) => {
		const interrupted: AssistantMessage = {
			...createAssistant(300, 9_000),
			stopReason,
			content: [
				{ type: "text", text: "unfinished answer".repeat(1000) },
				{ type: "thinking", thinking: "unfinished thinking".repeat(1000) },
				{ type: "toolCall", id: "partial-call", name: "write", arguments: { content: "x".repeat(10_000) } },
			],
		};
		const messages = [
			createAssistant(100, 2_000),
			{ role: "user" as const, content: "inspect only", timestamp: 200 },
		];
		const context = normalizeContext({ messages: [...messages, interrupted] });
		const cleanContext = normalizeContext({ messages });

		expect(estimateMessageTokens(interrupted)).toBe(0);
		expect(estimateContextTokens(context)).toEqual(estimateContextTokens(cleanContext));
		expect(buildBaseOptions(model, context).maxTokens).toBe(buildBaseOptions(model, cleanContext).maxTokens);
		expect(estimateContextTokens([messages[1], interrupted])).toEqual(estimateContextTokens([messages[1]]));
	});

	it.each(["aborted", "error"] as const)("does not let omitted %s timestamps invalidate usage", (stopReason) => {
		const interrupted = { ...createAssistant(500, 9_000), stopReason };
		const estimate = estimateContextTokens([
			{ role: "user", content: "request", timestamp: 200 },
			interrupted,
			createAssistant(300, 2_000),
		]);
		expect(estimate).toEqual({ tokens: 2_000, usageTokens: 2_000, trailingTokens: 0, lastUsageIndex: 2 });
	});

	it("still counts length-limited output under the existing recovery policy", () => {
		const message = { ...createAssistant(100, 0), stopReason: "length" as const };
		expect(estimateMessageTokens(message)).toBeGreaterThan(0);
	});

	// Regression for #10497: large new inputs need more room than chars/4 allows.
	it("reserves 3.5 characters per token for new text when limiting output", () => {
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: "x".repeat(3_500), timestamp: 200 }],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 3_000,
			usageTokens: 2_000,
			trailingTokens: 1_000,
			lastUsageIndex: 0,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(2_904);
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_149,
			usageTokens: 0,
			trailingTokens: 1_149,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_755);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_002,
			usageTokens: 2_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});
});

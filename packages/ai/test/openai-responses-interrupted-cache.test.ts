import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import type { Message, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "interrupted-cache-test",
	name: "Interrupted cache test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

interface CapturedRequest {
	payload: Record<string, unknown>;
	headers: Headers;
}

async function captureRequest(context: TranscriptContext, apiKey: string): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const result = await streamOpenAIResponses(model, context, {
		apiKey,
		sessionId: "same-session-cache-key",
		cacheRetention: "short",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			captured = { payload: JSON.parse(await request.text()), headers: request.headers };
			// Mock metadata tests parsing only; it does not establish a real server cache hit.
			const event = {
				type: "response.completed",
				sequence_number: 0,
				response: {
					id: "resp_mock_cache",
					status: "completed",
					output: [],
					usage: {
						input_tokens: 4096,
						input_tokens_details: { cached_tokens: 3072 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 4097,
					},
				},
			};
			return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	}).result();
	if (!captured) throw new Error("Mock request was not captured");
	expect(result.stopReason).toBe("stop");
	expect(result.usage.cacheRead).toBe(3072);
	return captured;
}

describe("OpenAI interrupted-response cache prefix", () => {
	it.each([
		{ stopReason: "aborted", apiKey: "chatgpt-mock-access-token" },
		{ stopReason: "error", apiKey: "chatgpt-mock-access-token" },
		{ stopReason: "aborted", apiKey: "sk-mock-api-key" },
		{ stopReason: "error", apiKey: "sk-mock-api-key" },
	] as const)(
		"preserves the request prefix and cache affinity after $stopReason with $apiKey",
		async ({ stopReason, apiKey }) => {
			const prefix: Message[] = [
				{ role: "user", content: "Earlier request", timestamp: 1 },
				fauxAssistantMessage("Earlier completed response", { timestamp: 2 }),
				{ role: "user", content: "Current request", timestamp: 3 },
			];
			const interrupted = fauxAssistantMessage(
				[
					fauxText("UNFINISHED_TEXT"),
					fauxThinking("UNFINISHED_THINKING"),
					fauxToolCall("write", { path: "never-written.ts", content: "unfinished" }),
				],
				{ stopReason, timestamp: 4 },
			);
			const correction: Message = { role: "user", content: "Correction: inspect only.", timestamp: 5 };
			const context = (messages: Message[]) => normalizeContext({ systemPrompt: "Stable system prompt", messages });
			const before = await captureRequest(context(prefix), apiKey);
			const withFragment = await captureRequest(context([...prefix, interrupted, correction]), apiKey);
			const withoutFragment = await captureRequest(context([...prefix, correction]), apiKey);

			expect(withFragment.payload.input).toEqual(withoutFragment.payload.input);
			const originalInput = before.payload.input;
			const nextInput = withoutFragment.payload.input;
			if (!Array.isArray(originalInput) || !Array.isArray(nextInput))
				throw new Error("Expected Responses input arrays");
			expect(nextInput.slice(0, originalInput.length)).toEqual(originalInput);
			for (const request of [before, withFragment, withoutFragment]) {
				expect(request.payload.prompt_cache_key).toBe("same-session-cache-key");
				expect(request.headers.get("session_id")).toBe("same-session-cache-key");
				expect(request.headers.get("x-client-request-id")).toBe("same-session-cache-key");
				expect(JSON.stringify(request.payload.input)).not.toContain("UNFINISHED_");
				expect(JSON.stringify(request.payload.input)).not.toContain("never-written.ts");
			}
		},
	);
});

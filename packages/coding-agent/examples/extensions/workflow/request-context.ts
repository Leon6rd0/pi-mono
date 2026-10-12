import type { TranscriptContext } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ModelRequestEstimate } from "./types.ts";

/** Estimate the exact normalized request, including system/tool declarations and replay. */
export function estimateWorkflowRequest(
	context: TranscriptContext,
	maxOutputTokens: number,
	contextWindow: number,
): ModelRequestEstimate {
	if (
		!Number.isSafeInteger(maxOutputTokens) ||
		maxOutputTokens < 1 ||
		!Number.isSafeInteger(contextWindow) ||
		contextWindow < 1
	)
		throw new Error("Invalid physical-model request limits");
	const usageAware = estimateContextTokens(context).tokens;
	const replay = context.messages.reduce((sum, message) => sum + estimateMessageTokens(message) + 4, 0);
	const estimatedInputTokens = Math.max(usageAware, replay);
	const marginTokens = Math.max(256, Math.ceil(estimatedInputTokens * 0.2));
	if (
		!Number.isSafeInteger(estimatedInputTokens) ||
		estimatedInputTokens < 0 ||
		estimatedInputTokens + marginTokens + maxOutputTokens > contextWindow
	)
		throw new Error(
			"Child request context estimate exceeds the physical model window; narrow evidence or compact explicitly",
		);
	return { estimatedInputTokens, maxOutputTokens, marginTokens, estimator: "context_usage_and_chars" };
}

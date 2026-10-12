import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { workflowThinkingLevels } from "./types.ts";

/** Workflow effort falls down to a supported level, never silently increasing requested effort. */
export function clampWorkflowThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	requested: ThinkingLevel,
): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (let index = workflowThinkingLevels.indexOf(requested); index >= 0; index--) {
		const level = workflowThinkingLevels[index];
		if (supported.includes(level)) return level;
	}
	throw new Error(`No supported thinking level at or below '${requested}' for ${model.provider}/${model.id}`);
}

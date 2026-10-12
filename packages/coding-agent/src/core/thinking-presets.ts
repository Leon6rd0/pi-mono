import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ResolvedCommand } from "./extensions/types.ts";

export interface ThinkingPresetChoice {
	value: string;
	label: string;
	description?: string;
	active: boolean;
	command: string;
}

/** Resolve extension-owned mode actions without widening the provider's ThinkingLevel enum. */
export function getThinkingPresets(
	commands: readonly ResolvedCommand[],
	levels: readonly ThinkingLevel[],
	ctx: ExtensionContext,
): ThinkingPresetChoice[] {
	const seen = new Set<string>(levels);
	const choices: ThinkingPresetChoice[] = [];
	for (const command of commands) {
		const preset = command.thinkingPreset;
		if (!preset || !/^[a-z][a-z0-9+_-]*$/.test(preset.value) || seen.has(preset.value)) continue;
		if (preset.thinkingLevel && !levels.includes(preset.thinkingLevel)) continue;
		try {
			if (preset.isAvailable && !preset.isAvailable(ctx)) continue;
			choices.push({
				value: preset.value,
				label: preset.label,
				description: command.description,
				active: preset.isActive?.(ctx) ?? false,
				command: `/${command.invocationName}`,
			});
			seen.add(preset.value);
		} catch {
			// A stale or failing extension must not prevent selection of ordinary thinking levels.
		}
	}
	return choices;
}

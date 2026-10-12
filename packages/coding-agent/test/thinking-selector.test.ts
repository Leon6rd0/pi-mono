import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("thinking selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the current thinking level marked while browsing", () => {
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
		);
		const getLevelRow = (level: string): string | undefined =>
			selector
				.getSelectList()
				.render(80)
				.map((line) => stripAnsi(line))
				.find((line) => line.includes(level));

		expect(selector.getSelectList().getSelectedItem()?.label).toBe("✓ medium");
		expect(getLevelRow("medium")?.startsWith("→ ✓ medium")).toBe(true);
		selector.handleInput("\x1b[B");
		expect(getLevelRow("medium")?.startsWith("  ✓ medium")).toBe(true);
		expect(getLevelRow("high")?.startsWith("→   high")).toBe(true);
	});

	it("renders and selects a session preset without sending it as a reasoning level or saving a default", () => {
		const selectLevel = vi.fn();
		const selectPreset = vi.fn();
		const saveDefault = vi.fn();
		const unsupported = vi.fn();
		const selector = new ThinkingSelectorComponent(
			"xhigh",
			["high", "xhigh"],
			selectLevel,
			() => {},
			saveDefault,
			"high",
			{
				items: [
					{
						value: "xhigh+workflow",
						label: "xhigh + Workflow",
						active: false,
						command: "/workflow-thinking",
						description: "Extra model tokens",
					},
				],
				onSelect: selectPreset,
				onSaveUnsupported: unsupported,
			},
		);
		for (const char of "workflow") selector.handleInput(char);
		expect(selector.getSelectList().getSelectedItem()?.value).toBe("xhigh+workflow");
		expect(selector.render(25).every((line) => visibleWidth(line) <= 25)).toBe(true);
		selector.handleInput("\x13");
		expect(unsupported).toHaveBeenCalledOnce();
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\r");
		expect(selectPreset).toHaveBeenCalledWith("xhigh+workflow");
		expect(selectLevel).not.toHaveBeenCalled();
	});

	it("preselects the active preset rather than marking ordinary xhigh as the combined mode", () => {
		const selector = new ThinkingSelectorComponent(
			"xhigh",
			["high", "xhigh"],
			() => {},
			() => {},
			undefined,
			undefined,
			{
				items: [
					{ value: "xhigh+workflow", label: "xhigh + Workflow", active: true, command: "/workflow-thinking" },
				],
				onSelect: () => {},
			},
		);
		expect(selector.getSelectList().getSelectedItem()?.label).toBe("✓ xhigh + Workflow");
		expect(stripAnsi(selector.getSelectList().render(80).join("\n"))).not.toMatch(/✓ xhigh\s+Extra-high/);
	});

	it("uses the configured save binding", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		const saveDefault = vi.fn();
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
			saveDefault,
		);

		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith("medium");
	});
});

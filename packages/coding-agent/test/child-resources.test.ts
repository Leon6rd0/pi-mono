import { describe, expect, it } from "vitest";
import {
	CHILD_RESOURCE_LIMITS,
	type ChildRole,
	createChildResourceSnapshot,
	type ResolvedChildResources,
} from "../src/core/child-resources.ts";

function resources(): ResolvedChildResources {
	return {
		cwd: "/project",
		epoch: "session:1",
		projectTrusted: true,
		instructions: [
			{
				path: "/global/AGENTS.md",
				content: "Do not release.",
				source: "global",
				provenance: "active host resource",
			},
			{ path: "/project/AGENTS.md", content: "Test all changes.", source: "project", provenance: "cwd ancestor" },
		],
		skills: [
			{
				path: "/project/.pi/skills/review.md",
				name: "review",
				roles: ["reviewer"],
				content: "Review evidence.",
				source: "project",
				provenance: "trusted catalog",
			},
			{
				path: "/global/skills/report.md",
				name: "report",
				roles: ["scout", "worker", "reviewer", "summarizer"],
				content: "Cite files.",
				source: "global",
				provenance: "host catalog",
			},
		],
	};
}

const roles: ChildRole[] = ["scout", "worker", "reviewer", "summarizer"];

describe("host-selected child resource snapshots", () => {
	it.each(roles)("retains all applicable instructions for %s without implicitly selecting skills", (role) => {
		const source = resources();
		const snapshot = createChildResourceSnapshot(source, { cwd: "/project", role });
		expect(snapshot.instructions).toEqual(source.instructions);
		expect(snapshot.skills).toEqual([]);
		expect(snapshot.prompt).toContain("Test all changes.");
		expect(snapshot.bytes).toBe(Buffer.byteLength(snapshot.prompt));
	});

	it("narrows the authorized skill catalog by role and explicit selection", () => {
		const snapshot = createChildResourceSnapshot(resources(), {
			cwd: "/project",
			role: "reviewer",
			skills: ["review", "review"],
		});
		expect(snapshot.skills.map((skill) => skill.name)).toEqual(["review"]);
		expect(snapshot.prompt).not.toContain("Cite files.");
		expect(() =>
			createChildResourceSnapshot(resources(), { cwd: "/project", role: "worker", skills: ["review"] }),
		).toThrow("not authorized");
		expect(() =>
			createChildResourceSnapshot(resources(), { cwd: "/project", role: "reviewer", skills: ["missing"] }),
		).toThrow("not authorized");
	});

	it("uses the effective child trust decision, not a parent's persistent/default trust", () => {
		const source = { ...resources(), projectTrusted: false };
		expect(() =>
			createChildResourceSnapshot(source, { cwd: "/project", role: "reviewer", skills: ["review"] }),
		).toThrow("not authorized");
		const snapshot = createChildResourceSnapshot(source, { cwd: "/project", role: "reviewer", skills: ["report"] });
		expect(snapshot.skills.map((skill) => skill.name)).toEqual(["report"]);
		expect(snapshot.instructions).toHaveLength(2);
	});

	it("requires host resolution for a different cwd", () => {
		expect(() => createChildResourceSnapshot(resources(), { cwd: "/other", role: "scout" })).toThrow(
			"scope mismatch",
		);
		expect(() => createChildResourceSnapshot(resources(), { cwd: "relative", role: "scout" })).toThrow("absolute");
		expect(() => createChildResourceSnapshot(resources(), { cwd: "/project/../other", role: "scout" })).toThrow(
			"normalized",
		);
	});

	it("snapshots known resource fields only and freezes nested role selections", () => {
		const source = resources();
		const contaminated = {
			...source,
			parentHistory: "HISTORY_SENTINEL",
			apiKey: "CREDENTIAL_SENTINEL",
			instructions: source.instructions.map((instruction) => ({
				...instruction,
				systemPrompt: "PARENT_PROMPT_SENTINEL",
			})),
		};
		const snapshot = createChildResourceSnapshot(contaminated, {
			cwd: "/project",
			role: "reviewer",
			skills: ["review"],
		});
		contaminated.instructions[0].content = "changed later";
		expect(snapshot.prompt).toContain("Do not release.");
		expect(JSON.stringify(snapshot)).not.toContain("SENTINEL");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.instructions)).toBe(true);
		expect(Object.isFrozen(snapshot.instructions[0])).toBe(true);
		expect(Object.isFrozen(snapshot.skills[0].roles)).toBe(true);
	});

	it("rejects oversized UTF-8 prompts instead of silently dropping constraints", () => {
		const source = resources();
		source.instructions = [
			{
				...source.instructions[0],
				content: `${"约".repeat(CHILD_RESOURCE_LIMITS.maxBytes / 2)}Never write secrets.`,
			},
		];
		expect(() => createChildResourceSnapshot(source, { cwd: "/project", role: "worker" })).toThrow("not truncated");
	});

	it("bounds instructions and catalogs even when no skill is selected", () => {
		const source = resources();
		expect(() =>
			createChildResourceSnapshot(
				{ ...source, instructions: Array.from({ length: 65 }, () => source.instructions[0]) },
				{ cwd: "/project", role: "scout" },
			),
		).toThrow("count limit");
		expect(() =>
			createChildResourceSnapshot(
				{ ...source, skills: Array.from({ length: 257 }, () => source.skills[0]) },
				{ cwd: "/project", role: "scout" },
			),
		).toThrow("count limit");
	});

	it("rejects ambiguous catalogs and missing provenance", () => {
		const source = resources();
		expect(() =>
			createChildResourceSnapshot(
				{ ...source, skills: [source.skills[0], source.skills[0]] },
				{ cwd: "/project", role: "scout" },
			),
		).toThrow("catalog");
		expect(() =>
			createChildResourceSnapshot(
				{ ...source, instructions: [{ ...source.instructions[0], provenance: "" }] },
				{ cwd: "/project", role: "scout" },
			),
		).toThrow("provenance");
	});

	it("fingerprints content and scope identity deterministically", () => {
		const source = resources();
		const selection = { cwd: "/project", role: "scout" as const };
		const before = createChildResourceSnapshot(source, selection);
		expect(createChildResourceSnapshot(source, selection).sha256).toBe(before.sha256);
		expect(createChildResourceSnapshot({ ...source, epoch: "session:2" }, selection).sha256).not.toBe(before.sha256);
		expect(createChildResourceSnapshot(source, { ...selection, role: "worker" }).sha256).not.toBe(before.sha256);
	});
});

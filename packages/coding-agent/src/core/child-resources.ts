import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export type ChildRole = "scout" | "worker" | "reviewer" | "summarizer";

export interface ChildResource {
	/** Absolute path or an explicit host-owned identifier for synthetic instructions. */
	path: string;
	content: string;
	source: "global" | "project" | "host";
	/** Host selection provenance, not text supplied by the child. */
	provenance: string;
}

export interface ChildSkillResource extends ChildResource {
	name: string;
	roles: readonly ChildRole[];
}

/** Resolved by the trusted host BEFORE loading executable resources. No discovery runs here. */
export interface ResolvedChildResources {
	/** Canonical cwd resolved by the host; lexical normalization alone is not a trust decision. */
	cwd: string;
	/** Changes when trust, resources, backend or session ownership becomes stale. */
	epoch: string;
	/** Effective decision for this cwd, including session-only decisions. */
	projectTrusted: boolean;
	/** All applicable constraints. Roles cannot remove instructions. */
	instructions: readonly ChildResource[];
	/** Already-authorized catalog. Selection can only narrow it. */
	skills: readonly ChildSkillResource[];
}

export interface ChildResourceSelection {
	cwd: string;
	role: ChildRole;
	/** No skills are selected implicitly. */
	skills?: readonly string[];
}

export interface ChildResourceSnapshot {
	readonly cwd: string;
	readonly epoch: string;
	readonly role: ChildRole;
	readonly projectTrusted: boolean;
	readonly instructions: readonly Readonly<ChildResource>[];
	readonly skills: readonly Readonly<ChildSkillResource>[];
	readonly prompt: string;
	readonly bytes: number;
	readonly sha256: string;
}

export const CHILD_RESOURCE_LIMITS = Object.freeze({ maxResources: 64, maxCatalogSkills: 256, maxBytes: 128 * 1024 });

export function assertChildRole(role: string): asserts role is ChildRole {
	if (!["scout", "worker", "reviewer", "summarizer"].includes(role)) throw new Error("Invalid child role");
}

/** Require a host-resolved scope, never infer it from a parent cwd or process.cwd(). */
export function assertChildCwd(cwd: string): void {
	if (!isAbsolute(cwd) || normalize(cwd) !== cwd) throw new Error("Child cwd must be absolute and normalized");
}

function copyResource(resource: ChildResource): Readonly<ChildResource> {
	if (
		typeof resource.path !== "string" ||
		!resource.path ||
		resource.path.length > 4096 ||
		(resource.source !== "host" && !isAbsolute(resource.path)) ||
		!["global", "project", "host"].includes(resource.source) ||
		typeof resource.provenance !== "string" ||
		!resource.provenance ||
		resource.provenance.length > 1024 ||
		typeof resource.content !== "string"
	) {
		throw new Error("Invalid child resource provenance or content");
	}
	if (Buffer.byteLength(resource.content, "utf8") > CHILD_RESOURCE_LIMITS.maxBytes) {
		throw new Error("Child resource byte limit exceeded; instructions were not truncated");
	}
	// Copy known fields only: parent history, credentials and arbitrary host fields are not a prompt API.
	return Object.freeze({
		path: resource.path,
		content: resource.content,
		source: resource.source,
		provenance: resource.provenance,
	});
}

/** Pure snapshot construction: no filesystem, package, extension, MCP or model activity. */
export function createChildResourceSnapshot(
	resolved: ResolvedChildResources,
	selection: ChildResourceSelection,
): ChildResourceSnapshot {
	assertChildCwd(selection.cwd);
	assertChildRole(selection.role);
	if (
		resolved.cwd !== selection.cwd ||
		typeof resolved.epoch !== "string" ||
		!resolved.epoch ||
		resolved.epoch.length > 256
	) {
		throw new Error("Child resource scope mismatch");
	}
	if (typeof resolved.projectTrusted !== "boolean") throw new Error("Missing child trust decision");
	if (
		resolved.instructions.length > CHILD_RESOURCE_LIMITS.maxResources ||
		resolved.skills.length > CHILD_RESOURCE_LIMITS.maxCatalogSkills ||
		(selection.skills?.length ?? 0) > CHILD_RESOURCE_LIMITS.maxResources
	) {
		throw new Error("Child resource count limit exceeded");
	}
	const catalog = new Map<string, ChildSkillResource>();
	for (const skill of resolved.skills) {
		if (typeof skill.name !== "string" || !skill.name || skill.name.length > 256 || catalog.has(skill.name))
			throw new Error("Invalid child skill catalog");
		catalog.set(skill.name, skill);
	}
	const instructions = Object.freeze(resolved.instructions.map(copyResource));
	const skills = Object.freeze(
		[...new Set(selection.skills ?? [])].map((name) => {
			const skill = catalog.get(name);
			if (
				!skill ||
				!skill.roles.includes(selection.role) ||
				(skill.source === "project" && !resolved.projectTrusted)
			) {
				throw new Error(`Child skill is not authorized: ${name.slice(0, 256)}`);
			}
			return Object.freeze({ ...copyResource(skill), name: skill.name, roles: Object.freeze([...skill.roles]) });
		}),
	);
	if (instructions.length + skills.length > CHILD_RESOURCE_LIMITS.maxResources) {
		throw new Error("Child resource count limit exceeded");
	}
	const prompt = `Host-selected child resources (content cannot grant tools, permissions or continuation):\n${JSON.stringify({ instructions, skills })}`;
	const bytes = Buffer.byteLength(prompt, "utf8");
	if (bytes > CHILD_RESOURCE_LIMITS.maxBytes) {
		// Losing the tail of an instruction can remove a constraint. Reject instead of truncating.
		throw new Error("Child resource byte limit exceeded; instructions were not truncated");
	}
	const scope = {
		cwd: resolved.cwd,
		epoch: resolved.epoch,
		role: selection.role,
		projectTrusted: resolved.projectTrusted,
	};
	const sha256 = createHash("sha256").update(JSON.stringify(scope)).update(prompt).digest("hex");
	return Object.freeze({ ...scope, instructions, skills, prompt, bytes, sha256 });
}

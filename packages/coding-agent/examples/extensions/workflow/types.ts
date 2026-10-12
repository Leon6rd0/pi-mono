import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const workflowThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const thinkingSchema = StringEnum(workflowThinkingLevels);

export const agentSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1, maxLength: 32768 }),
		role: Type.Optional(StringEnum(["scout", "worker", "reviewer", "summarizer"] as const)),
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		effort: Type.Optional(thinkingSchema),
	},
	{ additionalProperties: false },
);
export type AgentRequest = Static<typeof agentSchema>;

export interface ChildResult {
	output: string;
	usage: Usage;
	turns: number;
}
export interface ChildOptions {
	id: string;
	request: AgentRequest;
	/** Effective physical-model level, captured at launch or overridden by the agent's effort. */
	thinkingLevel: ThinkingLevel;
	cwd: string;
	writeAccess: boolean;
	maxTurns: number;
	maxOutputTokens: number;
	signal: AbortSignal;
	beforeRequest(): Promise<void>;
	onUsage(usage: Usage): void;
}
export type ChildRunner = (options: ChildOptions) => Promise<ChildResult>;
export type ScriptRunner = (
	code: string,
	ctx: ExtensionToolContext,
	signal: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

export interface AgentRecord {
	id: string;
	role: NonNullable<AgentRequest["role"]>;
	label: string;
	phase: string;
	status: "queued" | "running" | "completed" | "failed" | "stopped";
	output?: string;
	error?: string;
	turns?: number;
	/** Absent only on records created before effort accounting was introduced. */
	thinkingLevel?: ThinkingLevel;
}
export interface WorkflowRecord {
	id: string;
	label: string;
	cwd: string;
	provider: string;
	model: string;
	/** Captured launch thinking, clamped to the selected physical model. Old history may omit it. */
	thinkingLevel?: ThinkingLevel;
	status: "running" | "paused" | "awaiting_result" | "archived";
	outcome?: "completed" | "failed" | "stopped" | "unknown";
	phase: string;
	agents: AgentRecord[];
	usage: Usage;
	createdAt: number;
	updatedAt: number;
	result?: string;
	error?: string;
	resultRead?: boolean;
	usageReported?: boolean;
	acknowledgedAt?: number;
	acknowledgement?: string;
}
export interface WorkflowLimits {
	concurrency: number;
	maxAgents: number;
	maxTurns: number;
	maxOutputTokens: number;
	maxTotalTokens: number;
	timeoutSeconds: number;
}
export const defaultLimits: WorkflowLimits = {
	concurrency: 4,
	maxAgents: 32,
	maxTurns: 16,
	maxOutputTokens: 4096,
	maxTotalTokens: 200000,
	timeoutSeconds: 3600,
};
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
export function addUsage(target: Usage, source: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += source[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		target.cost[key] += source.cost[key];
}

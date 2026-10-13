import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { TextArchive } from "./artifacts.ts";
import type { BudgetTotals, WorkflowBudgetSnapshot } from "./budget.ts";

export const workflowThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const thinkingSchema = StringEnum(workflowThinkingLevels);

export const agentSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1, maxLength: 32768 }),
		role: Type.Optional(StringEnum(["scout", "worker", "reviewer", "summarizer"] as const)),
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		effort: Type.Optional(thinkingSchema),
		maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000000 })),
	},
	{ additionalProperties: false },
);
export type AgentRequest = Static<typeof agentSchema>;

export interface ChildResult {
	/** Host-only final text. The manager bounds what scripts/models receive. */
	output: string;
	outputTruncated?: boolean;
	outputOriginalLength?: number;
	usage: Usage;
	turns: number;
}
export interface UsageObservation {
	/** Trusted assertion that complete usage was received; can explicitly confirm a genuine zero. */
	reported: boolean;
}
export interface ModelRequestEstimate {
	estimatedInputTokens: number;
	maxOutputTokens: number;
	marginTokens: number;
	/** Heuristic, not a provider tokenizer or billing receipt. */
	estimator: "context_usage_and_chars" | "trusted_host";
}
export interface ToolProgress {
	id: string;
	name: string;
	path?: string;
	mutation: boolean;
	status: "started" | "completed" | "failed" | "unknown";
	result?: string;
	truncated?: boolean;
}
export interface ChildProgress {
	/** Retained observations are untrusted partial evidence, not task acceptance. */
	partial: true;
	output: string;
	outputTruncated: boolean;
	operations: ToolProgress[];
	droppedOperations: number;
	updatedAt: number;
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
	beforeRequest(estimate: ModelRequestEstimate): Promise<string>;
	/** Provider handoff attempt, not proof the server accepted/billed the request. */
	onRequestDispatched?(requestId: string): void;
	onUsage(usage: Usage, observation: UsageObservation | undefined, requestId: string): void;
	onProgress?(progress: ChildProgress): void;
}
export type ChildRunner = (options: ChildOptions) => Promise<ChildResult>;
export interface WorkflowScriptResult extends AgentToolResult<unknown> {
	/** Upstream renderer already omitted output; original length may be unavailable. */
	outputTruncated?: boolean;
	/** Current trusted host spill only; never parsed from script text/JSON or persisted as an import path. */
	fullOutputPath?: string;
}
export type ScriptRunner = (
	code: string,
	ctx: ExtensionToolContext,
	signal: AbortSignal,
) => Promise<WorkflowScriptResult>;

export interface ModelRequestRecord {
	id: string;
	/** Billing observation, not whether the model response or assigned work succeeded. */
	status: "in_flight" | "reported" | "unknown" | "not_sent";
	estimate?: ModelRequestEstimate;
	reservedTokens?: number;
	underestimatedTokens?: number;
	/** Historical overrides without admission used usage_only; new usage requires an admitted ID. */
	source: "request_gate" | "usage_only";
	startedAt?: number;
	/** Time handed to the provider client; network acceptance is not asserted. */
	dispatchedAt?: number;
	reportedAt?: number;
	usage?: Usage;
}
export interface AgentRecord {
	id: string;
	role: NonNullable<AgentRequest["role"]>;
	label: string;
	phase: string;
	phaseId?: string;
	budget?: BudgetTotals;
	progress?: ChildProgress;
	status: "queued" | "running" | "completed" | "failed" | "stopped";
	output?: string;
	outputTruncated?: boolean;
	outputOriginalLength?: number;
	outputArchive?: TextArchive;
	error?: string;
	turns?: number;
	/** Missing on historical records means unavailable, not zero. */
	usage?: Usage;
	requests?: ModelRequestRecord[];
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
	phaseId?: string;
	phases?: Array<{ id: string; title: string }>;
	budget?: WorkflowBudgetSnapshot;
	agents: AgentRecord[];
	usage: Usage;
	createdAt: number;
	updatedAt: number;
	result?: string;
	resultTruncated?: boolean;
	resultOriginalLength?: number;
	resultArchive?: TextArchive;
	deliveryComplete?: boolean;
	error?: string;
	resultRead?: boolean;
	usageReported?: boolean;
	/** Actual known token count returned once to the parent; later correction isn't billed twice. */
	usageReportedTokens?: number;
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

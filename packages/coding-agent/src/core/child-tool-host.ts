import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { assertChildCwd, type ResolvedChildResources } from "./child-resources.ts";
import type { ChildToolInvocation, ChildToolScopeHost } from "./child-tool-scope.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { ExtensionContext, ExtensionUIDialogOptions, ToolCallEvent, ToolResultEvent } from "./extensions/types.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { createTool } from "./tools/index.ts";

export const CHILD_FILESYSTEM_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;

export interface ChildToolHostOptions {
	cwd: string;
	/** Independent child lifetime, never the launching parent turn's signal. */
	signal: AbortSignal;
	model: Model<string>;
	thinkingLevel: ThinkingLevel;
}

export interface ChildToolHost extends ChildToolScopeHost {
	readonly resources: ResolvedChildResources;
	readonly signal: AbortSignal;
	abort(): void;
}

/** Canonical tool-path guard, not an OS sandbox; concurrent filesystem changes remain a TOCTOU risk. */
export function childWorkspacePath(cwd: string, input: string): string {
	const path = resolve(cwd, input);
	let ancestor = path;
	while (true) {
		try {
			lstatSync(ancestor);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			ancestor = parent;
		}
	}
	const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
	const child = relative(cwd, canonical);
	if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
		throw new Error("Child tool path is outside the workflow workspace");
	return path;
}

/** Internal session bridge: only the host can attest to backend identity and live grants. */
export function createChildToolHost(
	options: ChildToolHostOptions,
	bindings: {
		runner: ExtensionRunner;
		parentCwd: string;
		resourceLoader: ResourceLoader;
		isProjectTrusted(): boolean;
		/** Must reject unsupported/replaced backends, not silently drop or recreate them. */
		getToolNames(): string[];
		autoResizeImages: boolean;
	},
): ChildToolHost {
	assertChildCwd(options.cwd);
	const cwd = realpathSync(options.cwd);
	if (cwd !== options.cwd || !statSync(cwd).isDirectory()) throw new Error("Child cwd must be canonical directory");
	const { runner, resourceLoader } = bindings;
	const assertPolicy = runner.captureToolPolicyGuard();
	assertPolicy();
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, runner.lifetimeSignal, controller.signal]);
	signal.throwIfAborted();
	const names = bindings.getToolNames();
	const sameCwd = cwd === realpathSync(bindings.parentCwd);
	const parentTrust = bindings.isProjectTrusted();
	const loadedContext = JSON.stringify(resourceLoader.getAgentsFiles().agentsFiles);
	if (!resourceLoader.getChildContextFiles && !sameCwd)
		throw new Error("Resource loader cannot resolve child context for another cwd");
	const instructions = resourceLoader.getChildContextFiles
		? resourceLoader.getChildContextFiles(cwd)
		: resourceLoader.getAgentsFiles().agentsFiles.map((entry) => ({
				...entry,
				source: "host" as const,
				provenance: "Host loader: effective same-cwd context",
			}));
	const epoch = randomUUID();
	const resources: ResolvedChildResources = {
		cwd,
		epoch,
		// Cross-cwd supports passive constraints only, not inherited executable-project trust.
		projectTrusted: sameCwd && parentTrust,
		instructions,
		skills: [],
	};
	const backendId = "local-default-filesystem";
	const getState = () => {
		assertPolicy();
		signal.throwIfAborted();
		if (
			bindings.isProjectTrusted() !== parentTrust ||
			JSON.stringify(resourceLoader.getAgentsFiles().agentsFiles) !== loadedContext
		)
			throw new Error("Child resource/trust snapshot is stale");
		return { cwd, epoch, backendId, projectTrusted: resources.projectTrusted, toolNames: bindings.getToolNames() };
	};
	const unavailable = () => {
		throw new Error("Parent session controls are unavailable in a child policy context");
	};
	const contextFor = (call: ChildToolInvocation): ExtensionContext => {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(runner.createContext()),
		) as ExtensionContext;
		const guarded =
			<T>(value: () => T) =>
			() => {
				getState();
				call.signal.throwIfAborted();
				return value();
			};
		const dialogOptions = (opts?: ExtensionUIDialogOptions): ExtensionUIDialogOptions => ({
			...opts,
			signal: opts?.signal ? AbortSignal.any([call.signal, opts.signal]) : call.signal,
		});
		Object.defineProperties(context, {
			cwd: { get: guarded(() => cwd) },
			signal: { get: () => call.signal },
			childScope: { get: guarded(() => call.scope) },
			model: { get: guarded(() => options.model) },
			thinkingLevel: { get: guarded(() => options.thinkingLevel) },
			createChildToolHost: { value: undefined },
			ui: {
				get: guarded(() => {
					const ui = runner.createContext().ui;
					return {
						...ui,
						select: (title: string, choices: string[], opts?: ExtensionUIDialogOptions) =>
							ui.select(title, choices, dialogOptions(opts)),
						confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
							ui.confirm(title, message, dialogOptions(opts)),
						input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
							ui.input(title, placeholder, dialogOptions(opts)),
						editor: unavailable,
						custom: unavailable,
					};
				}),
			},
		});
		context.abort = () => controller.abort();
		context.isIdle = () => false;
		context.isProjectTrusted = guarded(() => resources.projectTrusted);
		context.hasPendingMessages = () => false;
		context.getContextUsage = () => undefined;
		context.getSystemPrompt = unavailable;
		context.compact = unavailable;
		context.shutdown = unavailable;
		return context;
	};
	return {
		resources,
		signal,
		abort: () => controller.abort(),
		getState,
		tools: CHILD_FILESYSTEM_TOOLS.filter((name) => names.includes(name)).map((name) => {
			const tool = createTool(name, cwd, { read: { autoResizeImages: bindings.autoResizeImages } });
			return {
				...tool,
				prepareArguments: (input: unknown) => {
					const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
					if (!prepared || typeof prepared !== "object" || Array.isArray(prepared))
						throw new Error("Expected tool arguments");
					const args = prepared as Record<string, unknown>;
					if (args.path !== undefined && typeof args.path !== "string") throw new Error("path must be a string");
					return { ...args, path: childWorkspacePath(cwd, (args.path as string | undefined) ?? ".") };
				},
			};
		}),
		checkCall: (call) => {
			const state = getState();
			return (
				call.scope.cwd === cwd &&
				call.scope.epoch === epoch &&
				call.scope.backendId === backendId &&
				state.toolNames.includes(call.toolName) &&
				typeof call.args.path === "string" &&
				childWorkspacePath(cwd, call.args.path) === call.args.path
			);
		},
		authorize: async (call) => {
			const decision = await runner.emitToolCall(
				Object.freeze({
					type: "tool_call",
					toolName: call.toolName,
					toolCallId: call.id,
					input: call.args,
				}) as ToolCallEvent,
				contextFor(call),
			);
			return { allow: decision?.block !== true };
		},
		filterResult: async (call, result) => {
			const filtered = await runner.emitToolResult(
				{
					type: "tool_result",
					toolName: call.toolName,
					toolCallId: call.id,
					input: call.args,
					content: result.content,
					details: result.details,
					structuredContent: result.structuredContent,
					isError: result.isError === true,
				} as ToolResultEvent,
				{ context: contextFor(call), failClosed: true },
			);
			return filtered ? { ...result, ...filtered } : result;
		},
	};
}

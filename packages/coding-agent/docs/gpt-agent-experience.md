# GPT agent experience

This fork aims to make Pi with GPT models approach Claude Code's coding workflow experience. The goal is reliable task execution and continuity, not copying a product's wording or assuming model capabilities are interchangeable.

## What good behavior means

- Follow the user's latest applicable request and preserve earlier constraints that still apply.
- Inspect relevant files, make scoped changes, verify them, and report what actually ran.
- Continue multi-step work without asking for confirmation at every harmless step, while respecting explicit permission boundaries.
- Preserve user corrections, failure evidence, and the precise execution position across compaction.
- Do not revive completed or cancelled work, repeat unchanged failed approaches, or turn an assistant suggestion into user authorization.
- Keep the user informed with concise progress and a clear final result, including remaining blockers.

These are behavioral acceptance criteria, not a claim that prompt changes alone achieve parity.

## First increment: compaction continuity

The current increment changes the shared compaction path, without selecting a special model or depending on a Claude API:

1. **Intent-preserving checkpoints.** Goals include decisive user wording and explicit success criteria. Updates reconcile older checkpoints with newer requests rather than accumulating every historical goal as active work.
2. **Evidence and stopping position.** Failed Attempts records the approach, failure, conditions, and reason not to retry unchanged. Current Work records the actual stopping point, pending results, and missing verification.
3. **Source provenance.** Summarization serializes original message roles. Shell output, extension messages, and previous summaries are not relabeled as user requests. Tool failures retain their status; long results preserve their beginning and end.
4. **Resumption boundaries.** A checkpoint is historical context, not new authorization. Later retained messages determine the active task. This is important when the user changes scope after the portion being summarized.
5. **Split-span consistency.** The same intent and evidence rules apply when compaction divides a long user-message span. Manual compact instructions reach that summary too.

The existing context thresholds, recent-message budget, provider selection, extension hooks, cancellation, and session scheduling remain unchanged. See [Compaction Reference](compaction.md) for the format and data flow.

### Validation

The offline tests cover:

- GPT-shaped model routing with an injected stream, without contacting OpenAI;
- initial, repeated-summary, and split-span prompt contracts;
- message provenance, tool status, and trailing failure evidence;
- branch-summary serialization and model-facing checkpoint conversion;
- manual compaction with a newer retained change of scope;
- automatic threshold compaction between a tool result and the next assistant response.

They verify prompt contracts and context assembly. A faux provider cannot establish that a real GPT model follows the rules or that the experience matches Claude Code.

## Follow-up work

Prioritize demonstrated failures rather than adding every Claude Code feature:

1. **Real-model evaluation.** With explicit permission to call paid models, compare the stable baseline and this fork on fixed scenarios: user corrections, cancelled goals, failed approaches, missing test verification, and repeated compaction. Measure goal drift, repeated work, omitted constraints, summary size, and cost.
2. **Tool orchestration.** Evaluate GPT tool selection, independent parallel calls, dependency ordering, large-output filtering, and recovery from partial failures. Add tools or codemode defaults only where they improve measured behavior.
3. **Task execution guidance.** Evaluate when the agent plans, inspects, edits, verifies, and stops. Avoid broad autonomy rules that override user restrictions or project instructions.
4. **Interaction and retrieval.** Evaluate progress reporting, interruption and steering, checkpoint visibility, and targeted retrieval of pre-compaction artifacts or transcript details.
5. **Long-lived project knowledge.** Keep reusable project facts and preferences separate from the session's task handoff. A compact summary is not a replacement for project instructions or reviewed persistent memory.

Changes are developed in the fork and validated before deploying to an installed Pi. Updating the source checkout alone does not change an already running session or the globally installed CLI.

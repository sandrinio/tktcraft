import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluatePostToolUsePayload,
  evaluateTrackerCommand,
  isTrackerCommand,
  isTrackerPreview,
  writePreHookApprovalToken,
} from './agent-harness.ts';

type HookMode = 'pre-tool' | 'post-tool';
type HookOutput = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isObject(value)) {
    if (value.resultType === 'failure' || value.result_type === 'failure' ||
        (typeof value.exitCode === 'number' && value.exitCode !== 0)) {
      throw new Error('The tracker command failed. Read back the ticket before retrying a write.');
    }
    for (const key of ['textResultForLlm', 'text_result_for_llm', 'stdout', 'output']) {
      if (typeof value[key] === 'string') return value[key];
    }
    if (Array.isArray(value.content)) {
      return value.content.map((entry: unknown) => {
        if (!isObject(entry) || typeof entry.text !== 'string') {
          throw new Error('Unsupported tracker result content; expected text entries.');
        }
        return entry.text;
      }).join('\n');
    }
    if (isObject(value.links) || typeof value.directUrl === 'string') {
      return JSON.stringify(value);
    }
  }
  throw new Error('Unsupported tracker tool result; expected text or structured CLI output.');
}

function ticketLinks(text: string): { direct?: string; board?: string } {
  const direct = text.match(/Direct(?: Ticket)? Link(?:\*\*)?\s*[:|]\s*(https?:\/\/[^\s|]+)/i)?.[1];
  const board = text.match(/(?:Connected )?Board(?: View)? Link(?:\*\*)?\s*[:|]\s*(https?:\/\/[^\s|]+)/i)?.[1];
  // JSON/agent output may follow a preview in combined terminal stdout/stderr.
  const jsonDirect = [...text.matchAll(/"directUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/g)].at(-1)?.[1];
  const jsonBoard = [...text.matchAll(/"boardViewUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/g)].at(-1)?.[1];
  return { direct: direct ?? jsonDirect, board: board ?? jsonBoard };
}

export function evaluateCopilotHook(
  rawInput: string,
  mode: HookMode,
  workspaceDir: string = process.cwd()
): HookOutput {
  const payload = parseObject(rawInput, 'Hook input');
  const local = Object.hasOwn(payload, 'tool_name');
  const toolName = local ? payload.tool_name : payload.toolName;
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new Error('Hook input requires tool_name (Local) or toolName (Copilot).');
  }
  if (local && Object.hasOwn(payload, 'toolName')) {
    throw new Error('Ambiguous hook input: both Local and Copilot tool fields were supplied.');
  }
  if (local && payload.hook_event_name !== (mode === 'pre-tool' ? 'PreToolUse' : 'PostToolUse')) {
    throw new Error('Local hook_event_name does not match the invoked hook mode.');
  }
  const rawArgs = local ? payload.tool_input : payload.toolArgs;
  const args = typeof rawArgs === 'string' ? parseObject(rawArgs, 'Tool arguments') : rawArgs;
  if (!isObject(args)) throw new Error('Tool arguments must be a JSON object.');

  const command = args.command ?? args.CommandLine ?? args.cmd;
  if (command === undefined) {
    if (/^(bash|powershell|run_in_terminal|run_command|shell|execute_command)$/i.test(toolName)) {
      throw new Error('Terminal tool arguments are missing a command.');
    }
    return {};
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Terminal command must be a nonempty string.');
  }
  const cwd = args.cwd ?? args.Cwd ?? payload.cwd ?? workspaceDir;
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Hook working directory must be a nonempty string.');
  const effectiveCwd = resolve(workspaceDir, cwd);

  if (mode === 'pre-tool') {
    const decision = evaluateTrackerCommand(command, effectiveCwd, writePreHookApprovalToken);
    // Defer to normal permissions for reads and unrelated commands, never pre-approve them.
    if (decision.decision === 'allow') return {};
    const permission = {
      permissionDecision: decision.decision === 'force_ask' ? 'ask' : 'deny',
      permissionDecisionReason: decision.reason,
    };
    return local
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', ...permission } }
      : permission;
  }

  if (!isTrackerCommand(command)) {
    return {};
  }
  const result = local ? payload.tool_response : payload.toolResult;
  const text = toolResultText(result);
  const links = ticketLinks(text);
  const write = /\b(create|new-ticket|add-ticket|update|edit|transition|comment)\b/i.test(command);
  if (write && !isTrackerPreview(command) && (!links.direct || !links.board)) {
    throw new Error('Tracker write result is missing the direct ticket or connected board link. Read back the ticket before retrying; do not blindly repeat a create.');
  }
  if (!links.direct && !links.board) return {};
  const reminder = evaluatePostToolUsePayload(JSON.stringify({
    output: [
      links.direct ? `Direct Link: ${links.direct}` : '',
      links.board ? `Board Link: ${links.board}` : '',
    ].join('\n'),
  })).postHookMessage;
  return local
    ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder } }
    : { additionalContext: reminder };
}

export function runCopilotHookCli(mode: HookMode): void {
  try {
    const output = evaluateCopilotHook(readFileSync(0, 'utf-8'), mode);
    console.log(JSON.stringify(output));
  } catch (error) {
    console.error(`[tkt Copilot Hook] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

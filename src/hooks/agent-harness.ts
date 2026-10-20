/**
 * AI Coding Agent Harness Hook Handler (`PreToolUse` & `PostToolUse`).
 *
 * Compatible with Claude Code, Antigravity, and Cursor `.agents/hooks.json`.
 * Invoked via:
 *   - `tkt hook pre-tool`  (reads toolCall JSON from stdin)
 *   - `tkt hook post-tool` (reads toolCall + toolOutput JSON from stdin)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActiveProfile } from '../config/manager.ts';
import { ensureWorkspaceHome } from '../config/paths.ts';

export interface AgentHookDecision {
  decision: 'allow' | 'deny' | 'force_ask';
  reason?: string;
  postHookMessage?: string;
}

export function isTrackerCommand(command: string): boolean {
  return /\b(tktcraft|tkt|jira_tool|jira|az\s+boards)\b|bin\/tkt\.js|src\/cli\.ts/i.test(command);
}

// A preview is only recognized when bash, PowerShell and cmd.exe would all pass the same plain
// --dry-run token; otherwise the shell that actually runs the command could execute a write.
// Expansion, escapes and operators of any of those shells (including cmd.exe's inside quotes,
// PowerShell's typographic quotes, and whitespace that only PowerShell splits on):
const SHELL_SENSITIVE = /[$`%^&|<>‘-„]|[^\S \t]/;
// Comments, grouping, script blocks and splatting, when unquoted:
const UNQUOTED_OPERATORS = /[;(){}#@]/;
// A backslash before these is a literal Windows path separator in every shell; before quotes,
// whitespace or another backslash the shells disagree about where arguments end.
const PATH_CHARACTER = /[A-Za-z0-9._-]/;

export function isTrackerPreview(command: string): boolean {
  if (SHELL_SENSITIVE.test(command)) return false;
  const tokens: Array<{ value: string; plain: boolean }> = [];
  let value = '';
  let quote = '';
  let plain = true;
  const finish = (): void => {
    if (value) tokens.push({ value, plain });
    value = '';
    plain = true;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\') {
      if (!PATH_CHARACTER.test(command[index + 1] ?? '')) return false;
      value += char;
      plain = false;
    } else if (quote) {
      // A literal double quote (PowerShell's "" escape, or " inside '...') is re-parsed by
      // Windows programs as a quote boundary.
      if (char === '"' && (quote === "'" || command[index + 1] === '"')) return false;
      if (char === quote) quote = '';
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      plain = false;
    } else if (UNQUOTED_OPERATORS.test(char)) {
      return false;
    } else if (char === ' ' || char === '\t') {
      finish();
    } else {
      value += char;
    }
  }
  if (quote) return false;
  finish();
  // `--dry-run=` (empty) after `--dry-run` turns the preview back off in the CLI flag parser.
  if (tokens.some((token) => token.value.startsWith('--dry-run='))) return false;
  const name = (token?: { value: string }): string => token?.value.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  let trackerIndex = 0;
  if (/^npx(?:\.cmd|\.ps1)?$/.test(name(tokens[0]))) {
    trackerIndex = tokens[1]?.value === '--no-install' ? 2 : 1;
  } else if (/^node(?:\.exe)?$/.test(name(tokens[0]))) {
    trackerIndex = 1;
    while (['--no-warnings', '--experimental-strip-types'].includes(tokens[trackerIndex]?.value)) trackerIndex++;
    if (!/(?:^|[\\/])(?:bin[\\/]tkt\.js|src[\\/]cli\.ts)$/i.test(tokens[trackerIndex]?.value ?? '')) return false;
    return tokens.slice(trackerIndex + 1).some((token) => token.plain && token.value === '--dry-run');
  }
  if (!/^(?:tkt|tktcraft)(?:\.cmd|\.ps1)?$/.test(name(tokens[trackerIndex]))) return false;
  return tokens.slice(trackerIndex + 1).some((token) => token.plain && token.value === '--dry-run');
}

export function stagePreHookApprovalToken(
  workspaceDir: string,
  source: 'pre-tool-hook' | 'cli-preview',
  summary: string
): void {
  try {
    writePreHookApprovalToken(workspaceDir, source, summary);
  } catch {
    // non-fatal if directory is read-only
  }
}

export function writePreHookApprovalToken(
  workspaceDir: string,
  source: 'pre-tool-hook' | 'cli-preview',
  summary: string
): void {
  const tokenPath = join(ensureWorkspaceHome(workspaceDir), 'pending-approval.json');
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(
    tokenPath,
    JSON.stringify({ stagedAt: Date.now(), source, summary }, null, 2),
    'utf-8'
  );
}

export function evaluatePreToolUsePayload(
  rawInput: string,
  workspaceDir: string = process.cwd()
): AgentHookDecision {
  if (!rawInput || !rawInput.trim()) {
    return { decision: 'allow' };
  }

  let payload: any;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return { decision: 'allow' };
  }

  const toolCall = payload.toolCall || payload.tool_input || payload;
  const toolName = String(
    toolCall.name || payload.tool_name || ''
  ).toLowerCase();
  const args = toolCall.args || toolCall.input || payload.tool_input || {};
  const commandLine = String(
    args.CommandLine || args.command || args.cmd || ''
  ).trim();
  const effectiveCwd = String(args.Cwd || args.cwd || workspaceDir);

  if (
    !commandLine ||
    (toolName &&
      !['run_command', 'bash', 'powershell', 'execute_command', 'shell'].includes(toolName))
  ) {
    return { decision: 'allow' };
  }

  return evaluateTrackerCommand(commandLine, effectiveCwd);
}

export function evaluateTrackerCommand(
  commandLine: string,
  workspaceDir: string,
  stageApproval: typeof stagePreHookApprovalToken = stagePreHookApprovalToken
): AgentHookDecision {
  const cmdLower = commandLine.toLowerCase();

  // Detect if command targets `tktcraft`, `tkt`, `jira`, or `az boards`
  if (!isTrackerCommand(commandLine)) {
    return { decision: 'allow' };
  }

  // 1. HARD DENIAL: Any delete / remove / purge / destroy operation
  if (
    /\b(delete|remove|destroy|drop|purge)\b/.test(cmdLower) ||
    cmdLower.includes('--delete') ||
    cmdLower.includes('--remove')
  ) {
    return {
      decision: 'deny',
      reason:
        '[tkt Pre-Hook Governance] Ticket deletion or removal in Jira / Azure DevOps is strictly forbidden by workspace policy. Transition obsolete tickets to Closed/Cancelled instead.',
    };
  }

  // Allow dry-run previews without interrupting the user, and stage approval token
  if (isTrackerPreview(commandLine)) {
    stageApproval(workspaceDir, 'cli-preview', commandLine);
    return { decision: 'allow' };
  }

  // 2. PRE-HOOK PERMISSION GATE: Any create or update mutation
  const isCreate = /\b(create|new-ticket|add-ticket)\b/.test(cmdLower);
  const isUpdate = /\b(update|edit|transition|comment)\b/.test(cmdLower);

  if (isCreate || isUpdate) {
    let boardSummary = 'Connected Board';
    try {
      const profile = resolveActiveProfile({ workspaceDir });
      boardSummary = `${profile.board.name} (${profile.provider.toUpperCase()} / ${profile.project})`;
    } catch {
      // ignore if profile not yet configured
    }

    // Record that PreToolUse asked permission so the CLI execution once approved can proceed
    stageApproval(workspaceDir, 'pre-tool-hook', commandLine);

    const actionLabel = isCreate ? 'Ticket Creation' : 'Ticket Update';
    return {
      decision: 'force_ask',
      reason: [
        `[tkt Pre-Hook Permission] ${actionLabel} requested on ${boardSummary}.`,
        `Proposed Command: ${commandLine}`,
        `Please grant permission to execute this change in Jira / Azure DevOps.`,
      ].join('\n'),
    };
  }

  return { decision: 'allow' };
}

export function evaluatePostToolUsePayload(rawInput: string): AgentHookDecision {
  if (!rawInput || !rawInput.trim()) {
    return { decision: 'allow' };
  }

  let payload: any;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return { decision: 'allow' };
  }

  const outputText = String(
    payload.output || payload.toolResult || payload.stdout || ''
  );

  // Extract Direct Link & Board Link if present in CLI output
  const directMatch = outputText.match(/Direct Link:\s*(https?:\/\/\S+)/i);
  const boardMatch = outputText.match(/Board Link:\s*(https?:\/\/\S+)/i);

  if (directMatch || boardMatch) {
    return {
      decision: 'allow',
      postHookMessage: [
        `[tkt Post-Hook Reminder] Mandatory Post-Hook Output Rule:`,
        `Include brief metadata of what was done and both clickable links in your response to the user:`,
        directMatch ? `1. Direct Ticket Link: ${directMatch[1]}` : '',
        boardMatch ? `2. Connected Board View Link: ${boardMatch[1]}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  return { decision: 'allow' };
}

export function runAgentHarnessHookCli(mode: 'pre-tool' | 'post-tool'): void {
  let rawInput = '';
  try {
    rawInput = readFileSync(0, 'utf-8');
  } catch {
    rawInput = '';
  }

  if (mode === 'pre-tool') {
    const res = evaluatePreToolUsePayload(rawInput);
    console.log(JSON.stringify(res));
    return;
  }

  evaluatePostToolUsePayload(rawInput);
  console.log(JSON.stringify({}));
}

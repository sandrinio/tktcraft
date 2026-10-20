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

export interface AgentHookDecision {
  decision: 'allow' | 'deny' | 'force_ask';
  reason?: string;
  postHookMessage?: string;
}

export function stagePreHookApprovalToken(
  workspaceDir: string,
  source: 'pre-tool-hook' | 'cli-preview',
  summary: string
): void {
  try {
    const tokenPath = join(workspaceDir, '.tkt', 'pending-approval.json');
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          stagedAt: Date.now(),
          source,
          summary,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch {
    // non-fatal if directory is read-only
  }
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
      !['run_command', 'bash', 'execute_command', 'shell'].includes(toolName))
  ) {
    return { decision: 'allow' };
  }

  const cmdLower = commandLine.toLowerCase();

  // Detect if command targets `tktcraft`, `tkt`, `jira`, or `az boards`
  const isTrackerCmd =
    /\b(tktcraft|tkt|jira_tool|jira|az\s+boards)\b/.test(cmdLower) ||
    cmdLower.includes('bin/tkt.js') ||
    cmdLower.includes('src/cli.ts');

  if (!isTrackerCmd) {
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
  if (cmdLower.includes('--dry-run')) {
    stagePreHookApprovalToken(effectiveCwd, 'cli-preview', commandLine);
    return { decision: 'allow' };
  }

  // 2. PRE-HOOK PERMISSION GATE: Any create or update mutation
  const isCreate = /\b(create|new-ticket|add-ticket)\b/.test(cmdLower);
  const isUpdate = /\b(update|edit|transition|comment)\b/.test(cmdLower);

  if (isCreate || isUpdate) {
    let boardSummary = 'Connected Board';
    try {
      const profile = resolveActiveProfile({ workspaceDir: effectiveCwd });
      boardSummary = `${profile.board.name} (${profile.provider.toUpperCase()} / ${profile.project})`;
    } catch {
      // ignore if profile not yet configured
    }

    // Record that PreToolUse asked permission so the CLI execution once approved can proceed
    stagePreHookApprovalToken(effectiveCwd, 'pre-tool-hook', commandLine);

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

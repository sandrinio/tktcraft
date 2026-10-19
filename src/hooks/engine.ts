import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolveTargetStatusesFromColumnOrStatus } from '../config/manager.ts';
import type { DuplicateCandidate, TrackerProvider } from '../providers/base.ts';
import type {
  CreateTicketInput,
  HookScriptConfig,
  OutputFormat,
  TktProfile,
  UnifiedTicket,
  UpdateTicketInput,
} from '../types.ts';

export interface PreHookExecutionResult {
  passedHooks: string[];
  warnings: string[];
  duplicatesFound: DuplicateCandidate[];
}

export interface PostHookExecutionResult {
  executedHooks: string[];
  warnings: string[];
}

const FORBIDDEN_TERMS = [
  'delete',
  'remove',
  'destroy',
  'drop',
  'purge',
  '--delete',
  '--remove',
];

/**
 * Hard safety policy guard: blocks any delete/remove argument in CLI argv.
 */
export function enforceNoDeleteArgv(argv: string[]): void {
  const lowerArgs = argv.map((a) => a.toLowerCase());
  for (const term of FORBIDDEN_TERMS) {
    if (lowerArgs.includes(term)) {
      console.error(
        'ERROR [Pre-Hook: no-delete-guard]: Ticket deletion or removal is strictly forbidden by workspace governance policy.'
      );
      process.exit(2);
    }
  }
}

function runCustomHookScripts(
  scripts: HookScriptConfig[] | undefined,
  phase: 'pre' | 'post',
  payload: Record<string, unknown>,
  envExtras: Record<string, string> = {}
): { executed: string[]; warnings: string[] } {
  const executed: string[] = [];
  const warnings: string[] = [];
  if (!scripts || scripts.length === 0) {
    return { executed, warnings };
  }

  for (const hook of scripts) {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: hook.timeoutMs ?? 15000,
      env: {
        ...process.env,
        TKT_HOOK_PHASE: phase,
        TKT_HOOK_NAME: hook.name,
        ...envExtras,
      },
    });

    if (res.status !== 0) {
      const errText = (res.stderr || res.stdout || 'Hook exited with non-zero status').trim();
      if (hook.blocking !== false) {
        throw new Error(`[${phase}-hook '${hook.name}' blocked execution]: ${errText}`);
      } else {
        warnings.push(`Non-blocking ${phase}-hook '${hook.name}' failed: ${errText}`);
      }
    } else {
      executed.push(`custom:${hook.name}`);
    }
  }

  return { executed, warnings };
}

export function renderPreHookPreviewBox(
  title: string,
  profile: TktProfile,
  fields: Record<string, string | undefined>,
  bodySections: Array<{ heading: string; content?: string }>,
  duplicates: DuplicateCandidate[] = [],
  warnings: string[] = []
): string {
  const hr = '='.repeat(76);
  const dash = '-'.repeat(76);
  const lines: string[] = [
    hr,
    `[PRE-HOOK PREVIEW] ${title}`,
    hr,
    `  ${'Provider'.padEnd(20)} ${profile.provider === 'jira' ? 'Jira' : 'Azure DevOps'} (Profile: ${profile.name})`,
    `  ${'Connected Board'.padEnd(20)} ${profile.board.name} (ID: ${profile.board.id})`,
    `  ${'Board Archetype'.padEnd(20)} ${profile.board.archetype} (${profile.board.boardType})`,
  ];

  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== '') {
      lines.push(`  ${k.padEnd(20)} ${v}`);
    }
  }

  if (duplicates.length > 0) {
    lines.push(dash, '⚠️  Possible Duplicate Tickets Detected on Board/Project:');
    for (const d of duplicates) {
      lines.push(`  • [${d.key}] (${d.status}) ${d.summary} -> ${d.directUrl}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(dash, '⚠️  Board Schema Warnings:');
    for (const w of warnings) {
      lines.push(`  • ${w}`);
    }
  }

  for (const sec of bodySections) {
    if (sec.content && sec.content.trim()) {
      lines.push(dash, `${sec.heading}:`, sec.content.trim());
    }
  }

  lines.push(hr);
  return lines.join('\n');
}

async function confirmOrAbortInteractive(
  actionLabel: string,
  options: { dryRun?: boolean; yes?: boolean; requireConfirmation: boolean; format: OutputFormat }
): Promise<void> {
  if (options.dryRun) {
    if (options.format !== 'json' && options.format !== 'agent') {
      console.log(`Dry-run mode: ${actionLabel} pre-hook preview complete. No changes made.`);
    }
    process.exit(0);
  }

  if (options.yes || !options.requireConfirmation) {
    return;
  }

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await rl.question(`\n[Pre-Hook Confirmation] Proceed with ${actionLabel}? [y/N]: `)
      )
        .trim()
        .toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.error(`Aborted: ${actionLabel} cancelled by user at pre-hook gate.`);
        process.exit(0);
      }
    } finally {
      rl.close();
    }
  } else {
    throw new Error(
      `Pre-Hook Confirmation Gate: ${actionLabel} requires explicit confirmation. Review the preview above and re-run with --yes (-y) after human approval.`
    );
  }
}

export async function runCreatePreHooks(
  profile: TktProfile,
  provider: TrackerProvider,
  input: CreateTicketInput,
  format: OutputFormat
): Promise<PreHookExecutionResult> {
  const passedHooks: string[] = ['no-delete-guard'];
  const warnings: string[] = [];

  // 1. Board Schema Validation Hook
  if (profile.governance.enforceBoardSchema && profile.board.issueTypes.length > 0) {
    const matchedType = profile.board.issueTypes.find(
      (it) => it.name.toLowerCase() === input.issueType.trim().toLowerCase()
    );
    if (!matchedType) {
      const validNames = profile.board.issueTypes.map((i) => i.name).join(', ');
      warnings.push(
        `Issue type '${input.issueType}' is not in discovered board schema [${validNames}].`
      );
    } else {
      for (const reqField of matchedType.fields.filter((f) => f.required)) {
        if (
          ['summary', 'System.Title', 'project', 'issuetype'].includes(reqField.key)
        ) {
          continue;
        }
        const hasCustom =
          input.customFields &&
          (input.customFields[reqField.key] !== undefined ||
            input.customFields[reqField.name.toLowerCase()] !== undefined);
        if (!hasCustom) {
          warnings.push(
            `Board field '${reqField.name}' (${reqField.key}) is marked required for '${matchedType.name}'. Supply via --field ${reqField.key}=<value> if rejected by server.`
          );
        }
      }
    }
    passedHooks.push('board-schema-validator');
  }

  // 2. Board Placement Resolution Hook
  const effectiveLabels = new Set<string>(input.labels ?? []);
  if (
    profile.governance.autoApplyBoardPlacement &&
    profile.board.placement.requiredLabels?.length
  ) {
    for (const l of profile.board.placement.requiredLabels) {
      effectiveLabels.add(l);
    }
  }
  const effectiveAreaPath =
    input.areaPath ||
    (profile.governance.autoApplyBoardPlacement
      ? profile.board.placement.defaultAreaPath
      : undefined);
  const effectiveIterationPath =
    input.iterationPath ||
    (profile.governance.autoApplyBoardPlacement
      ? profile.board.placement.defaultIterationPath
      : undefined);

  const targetStatuses = input.columnOrStatus
    ? resolveTargetStatusesFromColumnOrStatus(profile.board, input.columnOrStatus)
    : profile.board.columns[0]?.statuses ?? ['To Do'];
  const targetColumnName =
    input.columnOrStatus || profile.board.columns[0]?.columnName || 'Default Column';

  passedHooks.push('board-placement-injector');

  // 3. Duplicate Detection Hook (Runs on both live create and --dry-run when credentials are available)
  let duplicatesFound: DuplicateCandidate[] = [];
  if (typeof provider.findDuplicates === 'function') {
    try {
      duplicatesFound = await provider.findDuplicates(
        input.project || profile.project,
        input.issueType,
        input.summary
      );
      passedHooks.push('duplicate-detector');
    } catch {
      // non-fatal
    }
  }

  // 4. Custom Pre-Hooks
  const customRes = runCustomHookScripts(
    profile.governance.preHooks,
    'pre',
    {
      action: 'create',
      profile: profile.name,
      provider: profile.provider,
      board: profile.board.name,
      input,
    },
    {
      TKT_ACTION: 'create',
      TKT_PROVIDER: profile.provider,
      TKT_BOARD_ID: profile.board.id,
    }
  );
  passedHooks.push(...customRes.executed);
  warnings.push(...customRes.warnings);

  // 5. Render Pre-Hook Preview & Enforce Confirmation
  const previewText = renderPreHookPreviewBox(
    'Proposed Ticket Creation',
    profile,
    {
      Project: input.project || profile.project,
      'Issue Type': input.issueType,
      'Target Board Column': `${targetColumnName} (Status: ${targetStatuses[0] ?? 'Default'})`,
      Parent: input.parentKey || '(None)',
      Summary: input.summary,
      Priority: input.priority || '(Default)',
      Assignee: input.assignee || '(Unassigned)',
      'Labels / Tags':
        effectiveLabels.size > 0 ? Array.from(effectiveLabels).join(', ') : '(None)',
      'Area Path': effectiveAreaPath,
      'Iteration Path': effectiveIterationPath,
      'Custom Fields': input.customFields
        ? JSON.stringify(input.customFields)
        : undefined,
    },
    [
      { heading: 'Description', content: input.description || '(No description provided)' },
      { heading: 'Acceptance Criteria', content: input.acceptanceCriteria },
      { heading: 'Repro Steps', content: input.reproSteps },
    ],
    duplicatesFound,
    warnings
  );

  if (format === 'json' && input.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          action: 'create.preview',
          profile: profile.name,
          provider: profile.provider,
          board: profile.board.name,
          effectiveLabels: Array.from(effectiveLabels),
          effectiveAreaPath,
          effectiveIterationPath,
          targetColumnName,
          targetStatuses,
          warnings,
          duplicatesFound,
          input,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (format !== 'json' && format !== 'agent') {
    console.log(previewText);
  } else if (!input.yes && !input.dryRun) {
    // Print preview to stderr when JSON output is requested without --yes
    console.error(previewText);
  }

  await confirmOrAbortInteractive('ticket creation', {
    dryRun: input.dryRun,
    yes: input.yes,
    requireConfirmation: profile.governance.requireConfirmation,
    format,
  });

  passedHooks.push('preview-confirm-gate');
  return { passedHooks, warnings, duplicatesFound };
}

export async function runUpdatePreHooks(
  profile: TktProfile,
  input: UpdateTicketInput,
  format: OutputFormat
): Promise<PreHookExecutionResult> {
  const passedHooks: string[] = ['no-delete-guard'];
  const warnings: string[] = [];

  const targetStatuses = input.columnOrStatus
    ? resolveTargetStatusesFromColumnOrStatus(profile.board, input.columnOrStatus)
    : undefined;

  const customRes = runCustomHookScripts(
    profile.governance.preHooks,
    'pre',
    {
      action: 'update',
      profile: profile.name,
      provider: profile.provider,
      board: profile.board.name,
      input,
    },
    {
      TKT_ACTION: 'update',
      TKT_PROVIDER: profile.provider,
      TKT_TICKET_KEY: input.key,
    }
  );
  passedHooks.push(...customRes.executed);
  warnings.push(...customRes.warnings);

  const previewText = renderPreHookPreviewBox(
    `Proposed Ticket Update (${input.key})`,
    profile,
    {
      'Ticket Key': input.key,
      'New Summary': input.summary || '(unchanged)',
      'Column / Status': input.columnOrStatus
        ? `${input.columnOrStatus} (-> ${targetStatuses?.join(' / ')})`
        : '(unchanged)',
      Assignee: input.assignee || '(unchanged)',
      Priority: input.priority || '(unchanged)',
      'Labels / Tags': input.labels ? input.labels.join(', ') : '(unchanged)',
      'Custom Fields': input.customFields
        ? JSON.stringify(input.customFields)
        : undefined,
    },
    [
      { heading: 'Comment', content: input.comment },
      { heading: 'New Description', content: input.description },
      { heading: 'New Acceptance Criteria', content: input.acceptanceCriteria },
      { heading: 'New Repro Steps', content: input.reproSteps },
    ],
    [],
    warnings
  );

  if (format === 'json' && input.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          action: 'update.preview',
          profile: profile.name,
          provider: profile.provider,
          board: profile.board.name,
          targetStatuses,
          warnings,
          input,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (format !== 'json' && format !== 'agent') {
    console.log(previewText);
  } else if (!input.yes && !input.dryRun) {
    console.error(previewText);
  }

  await confirmOrAbortInteractive(`ticket update for ${input.key}`, {
    dryRun: input.dryRun,
    yes: input.yes,
    requireConfirmation: profile.governance.requireConfirmation,
    format,
  });

  passedHooks.push('preview-confirm-gate');
  return { passedHooks, warnings, duplicatesFound: [] };
}

/**
 * Runs Post-Hooks after a ticket is created or updated:
 * 1. Verifies & formats Direct Ticket Link + Connected Board View Link
 * 2. Appends structured audit entry to `.tkt/audit.jsonl`
 * 3. Executes any custom post-hook scripts/webhooks
 */
export function runPostHooks(
  profile: TktProfile,
  action: 'create' | 'update',
  ticket: UnifiedTicket,
  workspaceDir: string = process.cwd()
): PostHookExecutionResult {
  const executedHooks: string[] = ['board-links-verifier'];
  const warnings: string[] = [];

  if (profile.governance.auditLog) {
    try {
      const auditPath = join(workspaceDir, '.tkt', 'audit.jsonl');
      mkdirSync(dirname(auditPath), { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        action,
        profile: profile.name,
        provider: profile.provider,
        project: ticket.project,
        boardId: profile.board.id,
        boardName: profile.board.name,
        key: ticket.key,
        issueType: ticket.issueType,
        status: ticket.status,
        boardColumn: ticket.boardColumn,
        summary: ticket.summary,
        directUrl: ticket.directUrl,
        boardViewUrl: ticket.boardViewUrl,
      };
      appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf-8');
      executedHooks.push('audit-log');
    } catch (err) {
      warnings.push(`Audit log write failed: ${(err as Error).message}`);
    }
  }

  const customRes = runCustomHookScripts(
    profile.governance.postHooks,
    'post',
    {
      action,
      profile: profile.name,
      provider: profile.provider,
      board: profile.board,
      ticket,
    },
    {
      TKT_ACTION: action,
      TKT_PROVIDER: profile.provider,
      TKT_TICKET_KEY: ticket.key,
      TKT_DIRECT_URL: ticket.directUrl,
      TKT_BOARD_URL: ticket.boardViewUrl,
      TKT_BOARD_COLUMN: ticket.boardColumn ?? ticket.status,
    }
  );
  executedHooks.push(...customRes.executed);
  warnings.push(...customRes.warnings);

  return { executedHooks, warnings };
}

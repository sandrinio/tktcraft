#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateBoardContextMarkdown,
  loadWorkspaceConfig,
  resolveActiveProfile,
  resolveCredentials,
  saveWorkspaceConfig,
  upsertProfile,
} from './config/manager.ts';
import {
  renderBoardSchemaOutput,
  renderTicketListOutput,
  renderTicketOutput,
  renderTransitionsOutput,
} from './formatters/output.ts';
import { runAgentHarnessHookCli } from './hooks/agent-harness.ts';
import {
  enforceNoDeleteArgv,
  runCreatePreHooks,
  runPostHooks,
  runUpdatePreHooks,
} from './hooks/engine.ts';
import { AdoProvider } from './providers/ado.ts';
import type { TrackerProvider } from './providers/base.ts';
import { JiraProvider } from './providers/jira.ts';
import { runSetupWizard } from './setup/wizard.ts';
import type { OutputFormat, ProviderType, TktProfile } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');

function parseCliFlags(argv: string[]): {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        if (key === 'field') {
          const arr = (flags.field as string[]) || [];
          arr.push(val);
          flags.field = arr;
        } else {
          flags[key] = val;
        }
        i += 1;
        continue;
      }

      const key = arg.slice(2);
      if (
        ['dry-run', 'yes', 'board-only', 'refresh', 'non-interactive', 'help'].includes(
          key
        )
      ) {
        flags[key] = true;
        i += 1;
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (key === 'field') {
          const arr = (flags.field as string[]) || [];
          arr.push(next);
          flags.field = arr;
        } else {
          flags[key] = next;
        }
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length === 2) {
      const short = arg[1];
      const map: Record<string, string> = {
        p: 'project',
        t: 'type',
        s: 'summary',
        d: 'description',
        f: 'description-file',
        l: 'labels',
        a: 'assignee',
        c: 'comment',
        m: 'max-results',
        y: 'yes',
        o: 'format',
        h: 'help',
      };
      const mapped = map[short] || short;
      if (mapped === 'yes' || mapped === 'help') {
        flags[mapped] = true;
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[mapped] = next;
        i += 2;
      } else {
        flags[mapped] = true;
        i += 1;
      }
      continue;
    }

    positionals.push(arg);
    i += 1;
  }

  const command = positionals.shift() || 'help';
  return { command, positionals, flags };
}

function getProviderInstance(profile: TktProfile): TrackerProvider {
  const creds = resolveCredentials(profile);
  return profile.provider === 'jira'
    ? new JiraProvider(creds, profile)
    : new AdoProvider(creds, profile);
}

function parseCustomFieldFlags(rawFields: string | boolean | string[] | undefined): Record<string, string> | undefined {
  if (!rawFields) return undefined;
  const list = Array.isArray(rawFields)
    ? rawFields
    : typeof rawFields === 'string'
      ? [rawFields]
      : [];
  const out: Record<string, string> = {};
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq !== -1) {
      out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function printHelp(): void {
  console.log(`
tkt — Open-Source AI & Human CLI for Jira and Azure DevOps Boards
=================================================================

USAGE:
  tkt <command> [options]

SETUP & BOARD CONNECTION COMMANDS:
  tkt setup                     Interactive or flag-driven setup wizard (connects & introspects your chosen Board)
  tkt me | test                 Test authentication and display active profile + connected board
  tkt profiles                  List configured board profiles (--set-default <name>)
  tkt projects                  List accessible projects in Jira or Azure DevOps
  tkt boards [-p <PROJECT>]     List all boards in a project so you can choose which board to connect to
  tkt board-schema [--refresh]  Show the connected board's columns <-> statuses, required fields, and placement rules
  tkt discover                  Alias for 'board-schema --refresh' (live board introspection for AI agents)

TICKET & BOARD WORKFLOW COMMANDS:
  tkt search [QUERY]            Search tickets (JQL for Jira, WIQL/keywords for Azure DevOps, or --board-only)
  tkt get <KEY_OR_ID>           Inspect ticket details, board column, comments, and direct + board links
  tkt transitions <KEY_OR_ID>   List valid workflow transitions/states and their mapped Board Columns
  tkt create [options]          Create a ticket on the connected board (with Pre-Hooks & Post-Hooks)
  tkt update <KEY_OR_ID> [opts] Update fields, add comment, or move across Board Columns / Statuses
  tkt template [-t <TYPE>]      Print structured Markdown templates (story | bug | epic | initiative)

AI AGENT HARNESS HOOK COMMANDS:
  tkt hook pre-tool             PreToolUse hook interceptor (blocks deletes, enforces confirmation on create/update)
  tkt hook post-tool            PostToolUse hook processor (enforces Direct + Board View URL output)

GLOBAL OPTIONS:
  --profile <NAME>              Use a specific board profile from .tkt/config.json
  --provider <jira|ado>         Explicitly select provider ('jira' or 'ado')
  --format, -o <MODE>           Output format: human (default) | json | agent | md
  --dry-run                     Run pre-hooks and render preview without executing API mutations
  --yes, -y                     Confirm execution (after human approval in AI chat)
`);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // If invoked as `tkt hook pre-tool` or `tkt hook post-tool`, handle stdin JSON immediately
  if (rawArgv[0] === 'hook') {
    const mode = rawArgv[1] === 'post-tool' ? 'post-tool' : 'pre-tool';
    runAgentHarnessHookCli(mode);
    return;
  }

  // Enforce hard no-delete policy on CLI arguments
  enforceNoDeleteArgv(rawArgv);

  const { command, positionals, flags } = parseCliFlags(rawArgv);
  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  const format = ((flags.format as string) || 'human').toLowerCase() as OutputFormat;
  const profileName = typeof flags.profile === 'string' ? flags.profile : undefined;
  const providerFlag =
    typeof flags.provider === 'string'
      ? (flags.provider.toLowerCase() as ProviderType)
      : undefined;

  if (command === 'setup' || command === 'init') {
    const labelsRaw = typeof flags.labels === 'string' ? flags.labels : undefined;
    await runSetupWizard({
      provider: providerFlag,
      profileName,
      baseUrl: typeof flags.url === 'string' ? flags.url : undefined,
      user: typeof flags.user === 'string' ? flags.user : undefined,
      token: typeof flags.token === 'string' ? flags.token : undefined,
      authType: typeof flags['auth-type'] === 'string' ? (flags['auth-type'] as any) : undefined,
      project: typeof flags.project === 'string' ? flags.project : undefined,
      board: typeof flags.board === 'string' ? flags.board : undefined,
      requiredLabels: labelsRaw
        ? labelsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      nonInteractive: Boolean(flags['non-interactive']),
      format,
    });
    return;
  }

  if (command === 'profiles') {
    const cfg = loadWorkspaceConfig();
    if (!cfg || Object.keys(cfg.profiles).length === 0) {
      console.log("No profiles configured yet. Run 'tkt setup' to connect to a Jira or Azure DevOps board.");
      return;
    }
    if (typeof flags['set-default'] === 'string') {
      const target = flags['set-default'];
      if (!cfg.profiles[target]) {
        throw new Error(`Profile '${target}' not found.`);
      }
      cfg.defaultProfile = target;
      saveWorkspaceConfig(cfg);
      console.log(`✓ Default profile set to '${target}'.`);
      return;
    }
    if (format === 'json' || format === 'agent') {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    console.log(`Configured Board Profiles (.tkt/config.json):\n`);
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const def = cfg.defaultProfile === name ? ' * [DEFAULT]' : '';
      console.log(
        `  • ${name.padEnd(18)} | ${p.provider.toUpperCase().padEnd(5)} | Project: ${p.project.padEnd(14)} | Board: ${p.board.name} (#${p.board.id})${def}`
      );
    }
    return;
  }

  if (command === 'template') {
    const tplType = ((flags.type as string) || positionals[0] || 'story').toLowerCase();
    const map: Record<string, string> = {
      story: 'story_template.md',
      requirements: 'story_template.md',
      task: 'story_template.md',
      bug: 'bug_template.md',
      defect: 'bug_template.md',
      epic: 'epic_template.md',
      initiative: 'initiative_template.md',
      feature: 'initiative_template.md',
    };
    const filename = map[tplType] || 'story_template.md';
    const tplPath = join(
      PACKAGE_ROOT,
      '.agents',
      'skills',
      'tkt-ops',
      'assets',
      filename
    );
    if (existsSync(tplPath)) {
      console.log(readFileSync(tplPath, 'utf-8'));
    } else {
      throw new Error(`Template file not found at ${tplPath}`);
    }
    return;
  }

  // Resolve active profile (using ticket key hint if first positional looks like a key)
  const ticketKeyHint =
    ['get', 'inspect', 'update', 'transitions'].includes(command)
      ? positionals[0]
      : undefined;

  const profile = resolveActiveProfile({
    profileName,
    provider: providerFlag,
    ticketKeyHint,
  });

  if (command === 'board-schema' || command === 'discover') {
    const shouldRefresh = command === 'discover' || Boolean(flags.refresh);
    if (shouldRefresh && profile.board.id !== 'unconfigured') {
      const provider = getProviderInstance(profile);
      const refreshed = await provider.introspectBoard(profile.project, {
        id: profile.board.id,
        name: profile.board.name,
        type: profile.board.boardType,
        projectKey: profile.project,
        teamName: profile.board.placement.teamName,
        teamId: profile.board.placement.teamId,
      });
      profile.board = refreshed;
      upsertProfile(profile, false);
      generateBoardContextMarkdown(profile);
    }
    console.log(renderBoardSchemaOutput(profile, format));
    return;
  }

  if (command === 'me' || command === 'test') {
    const provider = getProviderInstance(profile);
    const info = await provider.testConnection();
    if (format === 'json' || format === 'agent') {
      console.log(
        JSON.stringify(
          {
            ok: true,
            user: info,
            activeProfile: profile.name,
            project: profile.project,
            connectedBoard: {
              id: profile.board.id,
              name: profile.board.name,
              boardUrl: profile.board.boardUrl,
            },
          },
          null,
          2
        )
      );
    } else {
      console.log(`✓ Successfully authenticated to ${info.provider === 'jira' ? 'Jira' : 'Azure DevOps'}!`);
      console.log(`  URL:             ${info.baseUrl}`);
      console.log(`  User:            ${info.displayName}${info.email ? ` (${info.email})` : ''}`);
      console.log(`  User ID:         ${info.id}`);
      console.log(`  Active Profile:  ${profile.name}`);
      console.log(`  Project:         ${profile.project}`);
      console.log(`  Connected Board: ${profile.board.name} (ID: ${profile.board.id})`);
      console.log(`  Board URL:       ${profile.board.boardUrl}`);
    }
    return;
  }

  if (command === 'projects') {
    const provider = getProviderInstance(profile);
    const projects = await provider.listProjects();
    if (format === 'json' || format === 'agent') {
      console.log(JSON.stringify({ ok: true, provider: profile.provider, projects }, null, 2));
      return;
    }
    console.log(`Found ${projects.length} accessible project(s) on ${profile.provider.toUpperCase()}:\n`);
    console.log(`${'Key / Name'.padEnd(22)} ${'Display Name'.padEnd(38)} Type`);
    console.log('-'.repeat(76));
    for (const p of projects) {
      console.log(`${p.key.padEnd(22)} ${p.name.slice(0, 37).padEnd(38)} ${p.projectType ?? ''}`);
    }
    return;
  }

  if (command === 'boards') {
    const provider = getProviderInstance(profile);
    const proj = (typeof flags.project === 'string' ? flags.project : profile.project);
    const boards = await provider.listBoards(proj);
    if (format === 'json' || format === 'agent') {
      console.log(
        JSON.stringify({ ok: true, provider: profile.provider, project: proj, boards }, null, 2)
      );
      return;
    }
    console.log(`Found ${boards.length} board(s) in project '${proj}' (${profile.provider.toUpperCase()}):\n`);
    console.log(`${'Board ID'.padEnd(24)} ${'Type'.padEnd(14)} Board Name`);
    console.log('-'.repeat(76));
    for (const b of boards) {
      const activeMarker = b.id === profile.board.id ? '  <-- [CONNECTED]' : '';
      console.log(`${b.id.padEnd(24)} ${b.type.padEnd(14)} ${b.name}${activeMarker}`);
    }
    return;
  }

  if (command === 'get' || command === 'inspect') {
    const key = positionals[0];
    if (!key) {
      throw new Error(`Missing ticket key/ID. Usage: tkt get <KEY_OR_ID>`);
    }
    const provider = getProviderInstance(profile);
    const ticket = await provider.getTicket(key);
    console.log(renderTicketOutput(ticket, profile, format, { action: 'get' }));
    return;
  }

  if (command === 'transitions') {
    const key = positionals[0];
    if (!key) {
      throw new Error(`Missing ticket key/ID. Usage: tkt transitions <KEY_OR_ID>`);
    }
    const provider = getProviderInstance(profile);
    const transitions = await provider.getTransitions(key);
    console.log(renderTransitionsOutput(key, transitions, profile, format));
    return;
  }

  if (command === 'search') {
    const query = positionals[0];
    const provider = getProviderInstance(profile);
    const maxResults =
      typeof flags['max-results'] === 'string' ? Number(flags['max-results']) : 20;
    const statusOrColumn =
      typeof flags.column === 'string'
        ? flags.column
        : typeof flags.status === 'string'
          ? flags.status
          : undefined;
    const issueType = typeof flags.type === 'string' ? flags.type : undefined;
    const assignee = typeof flags.assignee === 'string' ? flags.assignee : undefined;
    const boardOnly = Boolean(flags['board-only']);

    const tickets = await provider.searchTickets({
      query,
      boardOnly,
      statusOrColumn,
      issueType,
      assignee,
      maxResults,
    });
    console.log(
      renderTicketListOutput(
        tickets,
        profile,
        format,
        query || (boardOnly ? `board:${profile.board.name}` : `project:${profile.project}`)
      )
    );
    return;
  }

  if (command === 'create') {
    const summary = typeof flags.summary === 'string' ? flags.summary : '';
    const issueType =
      typeof flags.type === 'string'
        ? flags.type
        : profile.provider === 'jira'
          ? 'Task'
          : 'User Story';

    if (!summary.trim()) {
      throw new Error(
        `Missing --summary (-s). Usage: tkt create --type Story --summary "[Module] Add feature"`
      );
    }

    let description = typeof flags.description === 'string' ? flags.description : '';
    if (typeof flags['description-file'] === 'string') {
      const fPath = resolve(flags['description-file']);
      if (!existsSync(fPath)) {
        throw new Error(`Description file not found: ${fPath}`);
      }
      description = readFileSync(fPath, 'utf-8');
    }

    const labels =
      typeof flags.labels === 'string'
        ? flags.labels
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const columnOrStatus =
      typeof flags.column === 'string'
        ? flags.column
        : typeof flags.status === 'string'
          ? flags.status
          : undefined;

    let customFields = parseCustomFieldFlags(flags.field);
    if (typeof flags.theme === 'string') {
      customFields = { ...(customFields ?? {}), theme: flags.theme };
    }

    const createInput = {
      project: typeof flags.project === 'string' ? flags.project : profile.project,
      issueType,
      summary,
      description,
      acceptanceCriteria:
        typeof flags.ac === 'string'
          ? flags.ac
          : typeof flags['acceptance-criteria'] === 'string'
            ? flags['acceptance-criteria']
            : undefined,
      reproSteps:
        typeof flags['repro-steps'] === 'string' ? flags['repro-steps'] : undefined,
      parentKey: typeof flags.parent === 'string' ? flags.parent : undefined,
      priority: typeof flags.priority === 'string' ? flags.priority : undefined,
      assignee: typeof flags.assignee === 'string' ? flags.assignee : undefined,
      labels,
      columnOrStatus,
      areaPath: typeof flags['area-path'] === 'string' ? flags['area-path'] : undefined,
      iterationPath:
        typeof flags['iteration-path'] === 'string' ? flags['iteration-path'] : undefined,
      storyPoints:
        typeof flags.points === 'string' ? Number(flags.points) : undefined,
      customFields,
      dryRun: Boolean(flags['dry-run']),
      yes: Boolean(flags.yes),
    };

    // Instantiate provider (for dry-run without credentials, allow safe dummy fallback)
    let provider: TrackerProvider;
    try {
      provider = getProviderInstance(profile);
    } catch (err) {
      if (createInput.dryRun) {
        provider = {} as TrackerProvider;
      } else {
        throw err;
      }
    }

    // 1. Run Pre-Hooks (Validation, Placement Injection, Duplicate Check, Preview & Confirmation)
    const preRes = await runCreatePreHooks(profile, provider, createInput, format);

    // 2. Execute Ticket Creation
    const createdTicket = await provider.createTicket(createInput);

    // 3. Run Post-Hooks (Direct Link + Board View Link verification, Audit Log, Custom Post-Hooks)
    const postRes = runPostHooks(profile, 'create', createdTicket);

    if (format === 'human') {
      console.log(`\n✓ Ticket created successfully on board '${profile.board.name}'!`);
      console.log(`  Ticket Key:   ${createdTicket.key}`);
      console.log(`  Board Column: ${createdTicket.boardColumn ?? createdTicket.status} (Status: ${createdTicket.status})`);
      console.log(`  Direct Link:  ${createdTicket.directUrl}`);
      console.log(`  Board Link:   ${createdTicket.boardViewUrl}`);
    } else {
      console.log(
        renderTicketOutput(createdTicket, profile, format, {
          action: 'create',
          preHooksPassed: preRes.passedHooks,
          postHooksExecuted: postRes.executedHooks,
          warnings: [...preRes.warnings, ...postRes.warnings],
        })
      );
    }
    return;
  }

  if (command === 'update') {
    const key = positionals[0];
    if (!key) {
      throw new Error(`Missing ticket key/ID. Usage: tkt update <KEY_OR_ID> [options]`);
    }

    let description =
      typeof flags.description === 'string' ? flags.description : undefined;
    if (typeof flags['description-file'] === 'string') {
      const fPath = resolve(flags['description-file']);
      if (!existsSync(fPath)) {
        throw new Error(`Description file not found: ${fPath}`);
      }
      description = readFileSync(fPath, 'utf-8');
    }

    const labels =
      typeof flags.labels === 'string'
        ? flags.labels
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const columnOrStatus =
      typeof flags.column === 'string'
        ? flags.column
        : typeof flags.status === 'string'
          ? flags.status
          : undefined;

    let customFields = parseCustomFieldFlags(flags.field);
    if (typeof flags.theme === 'string') {
      customFields = { ...(customFields ?? {}), theme: flags.theme };
    }

    const updateInput = {
      key,
      summary: typeof flags.summary === 'string' ? flags.summary : undefined,
      description,
      acceptanceCriteria:
        typeof flags.ac === 'string'
          ? flags.ac
          : typeof flags['acceptance-criteria'] === 'string'
            ? flags['acceptance-criteria']
            : undefined,
      reproSteps:
        typeof flags['repro-steps'] === 'string' ? flags['repro-steps'] : undefined,
      comment: typeof flags.comment === 'string' ? flags.comment : undefined,
      columnOrStatus,
      priority: typeof flags.priority === 'string' ? flags.priority : undefined,
      assignee: typeof flags.assignee === 'string' ? flags.assignee : undefined,
      labels,
      parentKey: typeof flags.parent === 'string' ? flags.parent : undefined,
      areaPath: typeof flags['area-path'] === 'string' ? flags['area-path'] : undefined,
      iterationPath:
        typeof flags['iteration-path'] === 'string' ? flags['iteration-path'] : undefined,
      customFields,
      dryRun: Boolean(flags['dry-run']),
      yes: Boolean(flags.yes),
    };

    // 1. Run Pre-Hooks
    const preRes = await runUpdatePreHooks(profile, updateInput, format);

    // 2. Execute Update
    const provider = getProviderInstance(profile);
    const updatedTicket = await provider.updateTicket(updateInput);

    // 3. Run Post-Hooks
    const postRes = runPostHooks(profile, 'update', updatedTicket);

    if (format === 'human') {
      console.log(`\n✓ Ticket ${updatedTicket.key} updated successfully!`);
      console.log(`  Board Column: ${updatedTicket.boardColumn ?? updatedTicket.status} (Status: ${updatedTicket.status})`);
      console.log(`  Direct Link:  ${updatedTicket.directUrl}`);
      console.log(`  Board Link:   ${updatedTicket.boardViewUrl}`);
    } else {
      console.log(
        renderTicketOutput(updatedTicket, profile, format, {
          action: 'update',
          preHooksPassed: preRes.passedHooks,
          postHooksExecuted: postRes.executedHooks,
          warnings: [...preRes.warnings, ...postRes.warnings],
        })
      );
    }
    return;
  }

  throw new Error(`Unknown command '${command}'. Run 'tkt --help' for usage.`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});

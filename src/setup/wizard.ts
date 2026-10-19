import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  generateBoardContextMarkdown,
  generateMultiBoardIndexMarkdown,
  loadDotEnv,
  loadWorkspaceConfig,
  resolveCredentials,
  upsertDotEnvValues,
  upsertProfile,
} from '../config/manager.ts';
import { AdoProvider } from '../providers/ado.ts';
import type { BoardSummary, TrackerProvider } from '../providers/base.ts';
import { JiraProvider } from '../providers/jira.ts';
import type {
  OutputFormat,
  ProviderType,
  TktProfile,
} from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

export interface SetupWizardOptions {
  provider?: ProviderType;
  profileName?: string;
  baseUrl?: string;
  user?: string;
  token?: string;
  authType?: 'cloud' | 'datacenter' | 'pat' | 'bearer';
  project?: string;
  /** One or comma-separated Board IDs / Board Names to connect to on the same account */
  board?: string;
  requiredLabels?: string[];
  nonInteractive?: boolean;
  format?: OutputFormat;
  workspaceDir?: string;
}

function slugifyBoardAlias(
  project: string,
  board: BoardSummary,
  index: number,
  total: number,
  explicitProfile?: string
): string {
  if (explicitProfile && total === 1) {
    return explicitProfile;
  }
  const cleanName = board.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (explicitProfile && total > 1) {
    return `${explicitProfile}-${cleanName || board.id}`;
  }
  return cleanName || `${project.toLowerCase()}-board-${board.id || index + 1}`;
}

/**
 * Ensures `.env` is listed in `.gitignore` and scaffolds `.agents/` (skill + hooks)
 * into a fresh workspace if not already present.
 */
export function scaffoldWorkspaceAgentHarness(workspaceDir: string = process.cwd()): void {
  // 1. Ensure .gitignore protects .env
  const gitignorePath = join(workspaceDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.split(/\r?\n/).some((line) => line.trim() === '.env')) {
      writeFileSync(
        gitignorePath,
        content.replace(/\s*$/, '\n.env\n'),
        'utf-8'
      );
    }
  } else {
    writeFileSync(gitignorePath, '.env\nnode_modules/\n', 'utf-8');
  }

  // 2. Copy .agents/skills/tkt-ops and .agents/hooks.json if running in an external workspace
  const targetAgentsDir = join(workspaceDir, '.agents');
  const sourceAgentsDir = join(PACKAGE_ROOT, '.agents');
  if (
    resolve(workspaceDir) !== resolve(PACKAGE_ROOT) &&
    existsSync(sourceAgentsDir) &&
    !existsSync(join(targetAgentsDir, 'skills', 'tkt-ops', 'SKILL.md'))
  ) {
    mkdirSync(targetAgentsDir, { recursive: true });
    cpSync(sourceAgentsDir, targetAgentsDir, { recursive: true, force: false });
  }
}

function createTempProvider(
  providerType: ProviderType,
  baseUrl: string,
  user: string | undefined,
  token: string,
  authType: 'cloud' | 'datacenter' | 'pat' | 'bearer',
  project: string = 'TEMP',
  workspaceDir: string = process.cwd()
): TrackerProvider {
  const creds = resolveCredentials(providerType, workspaceDir, {
    baseUrl,
    user,
    token,
    authType,
  });
  const dummyProfile: TktProfile = {
    name: 'setup-temp',
    provider: providerType,
    baseUrl: creds.baseUrl,
    project,
    authType: creds.authType,
    board: {
      id: 'temp',
      name: 'Temp',
      boardType: 'kanban',
      archetype: 'kanban',
      boardUrl: creds.baseUrl,
      selectedTicketBoardUrlTemplate: creds.baseUrl,
      columns: [],
      issueTypes: [],
      placement: {},
      syncedAt: new Date().toISOString(),
    },
    governance: {
      forbidDelete: true,
      requireConfirmation: true,
      enforceBoardSchema: true,
      autoApplyBoardPlacement: true,
      auditLog: true,
    },
  };
  return providerType === 'jira'
    ? new JiraProvider(creds, dummyProfile)
    : new AdoProvider(creds, dummyProfile);
}

export async function runSetupWizard(options: SetupWizardOptions = {}): Promise<TktProfile> {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const env = { ...loadDotEnv(workspaceDir), ...process.env };
  const existingCfg = loadWorkspaceConfig(workspaceDir);
  const isInteractive = Boolean(process.stdin.isTTY && !options.nonInteractive);
  const rl = isInteractive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const ask = async (promptText: string, defaultVal?: string): Promise<string> => {
    if (!rl) return defaultVal ?? '';
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    const ans = (await rl.question(`${promptText}${suffix}: `)).trim();
    return ans || defaultVal || '';
  };

  try {
    if (options.format !== 'json') {
      console.log('='.repeat(76));
      console.log('🛠️  tktcraft — Unified Single-Account Multi-Board Setup Wizard');
      console.log('='.repeat(76));
    }

    // Step 1: Choose Provider (jira | ado) — enforce single account if workspace already initialized
    let provider: ProviderType | undefined = options.provider ?? existingCfg?.provider;
    if (!provider) {
      if (options.baseUrl?.includes('atlassian.net') || env.JIRA_URL || env.JIRA_TOKEN) {
        provider = 'jira';
      } else if (options.baseUrl?.includes('dev.azure.com') || env.ADO_ORG_URL || env.ADO_TOKEN) {
        provider = 'ado';
      } else if (isInteractive) {
        const choice = (
          await ask('1. Select issue tracker provider (1 = Jira, 2 = Azure DevOps)', '1')
        ).toLowerCase();
        provider =
          choice === '2' || choice === 'ado' || choice.includes('azure')
            ? 'ado'
            : 'jira';
      } else {
        throw new Error(
          `[ONBOARDING: MISSING CONNECTION DETAILS]\n` +
            `Please ask the user which issue tracker account to connect to:\n` +
            `  • Jira (Cloud or Data Center): requires --provider jira, --url <JIRA_URL>, --user <EMAIL> (for Cloud), --token <JIRA_TOKEN>\n` +
            `  • Azure DevOps Boards:         requires --provider ado,  --url <ADO_ORG_URL>, --token <ADO_TOKEN>`
        );
      }
    }

    // Step 2: Credentials & Base URL (Single-account shared across all connected boards)
    let baseUrl = options.baseUrl || existingCfg?.baseUrl || '';
    let user = options.user || '';
    let token = options.token || '';
    let authType: 'cloud' | 'datacenter' | 'pat' | 'bearer' =
      options.authType || (provider === 'jira' ? 'cloud' : 'pat');

    if (provider === 'jira') {
      const existingUrl = baseUrl || env.JIRA_URL || env.ATLASSIAN_URL || '';
      const existingUser = env.JIRA_USER || env.ATLASSIAN_USER_EMAIL || '';
      const existingToken = env.JIRA_TOKEN || env.ATLASSIAN_API_TOKEN || '';

      baseUrl = (
        options.baseUrl ||
        (await ask('2. Jira Base URL (e.g. https://your-org.atlassian.net)', existingUrl))
      ).replace(/\/+$/, '');

      const authChoice = (
        await ask('3. Jira Auth Type (cloud = Email + API Token, datacenter = Bearer PAT)', authType)
      ).toLowerCase();
      authType = authChoice.startsWith('d') || authChoice === 'bearer' ? 'datacenter' : 'cloud';

      if (authType === 'cloud') {
        user =
          user ||
          (await ask('4. Atlassian User Email (required for Jira Cloud)', existingUser));
      }
      token =
        token ||
        (await ask(
          `5. Jira API Token ${existingToken ? '(Press Enter to keep existing token in .env)' : ''}`,
          existingToken
        ));

      // Save whatever partial or complete credentials were provided to .env immediately
      const envToSave: Record<string, string> = { JIRA_AUTH_TYPE: authType };
      if (baseUrl) envToSave.JIRA_URL = baseUrl;
      if (user) envToSave.JIRA_USER = user;
      if (token) envToSave.JIRA_TOKEN = token;
      upsertDotEnvValues(envToSave, workspaceDir);

      // Check for missing connection details and emit structured onboarding prompt if anything is missing
      const missing: string[] = [];
      const provided: string[] = [];
      if (baseUrl) provided.push(`JIRA_URL (${baseUrl})`);
      else missing.push('JIRA_URL (--url https://your-domain.atlassian.net)');

      if (authType === 'cloud') {
        if (user) provided.push(`JIRA_USER (${user})`);
        else missing.push('JIRA_USER (--user your-email@domain.com — Atlassian account email is required alongside the API token for Jira Cloud)');
      }

      if (token) provided.push('JIRA_TOKEN (***configured***)');
      else missing.push('JIRA_TOKEN (--token <ATATT3x...>)');

      if (missing.length > 0) {
        throw new Error(
          `[ONBOARDING: MISSING CONNECTION DETAILS FOR JIRA]\n` +
            `Provided so far: ${provided.length > 0 ? provided.join(', ') : 'none'}\n` +
            `Missing required connection details:\n` +
            missing.map((m) => `  ✗ ${m}`).join('\n') +
            `\n\nAI Agent Action: Ask the user for the missing field(s) above, then re-run 'tkt setup'.`
        );
      }
    } else {
      const existingUrl = baseUrl || env.ADO_ORG_URL || '';
      const existingUser = env.ADO_USER || '';
      const existingToken = env.ADO_TOKEN || env.AZURE_TOKEN || '';

      baseUrl = (
        options.baseUrl ||
        (await ask(
          '2. Azure DevOps Organization URL (e.g. https://dev.azure.com/your-org)',
          existingUrl
        ))
      ).replace(/\/+$/, '');
      user =
        user ||
        (await ask('3. Azure DevOps User Email (optional, for display)', existingUser));
      token =
        token ||
        (await ask(
          `4. Azure DevOps Personal Access Token (PAT) ${existingToken ? '(Press Enter to keep existing token in .env)' : ''}`,
          existingToken
        ));

      const envToSave: Record<string, string> = {};
      if (baseUrl) envToSave.ADO_ORG_URL = baseUrl;
      if (user) envToSave.ADO_USER = user;
      if (token) envToSave.ADO_TOKEN = token;
      upsertDotEnvValues(envToSave, workspaceDir);

      const missing: string[] = [];
      const provided: string[] = [];
      if (baseUrl) provided.push(`ADO_ORG_URL (${baseUrl})`);
      else missing.push('ADO_ORG_URL (--url https://dev.azure.com/your-org)');

      if (token) provided.push('ADO_TOKEN (***configured***)');
      else missing.push('ADO_TOKEN (--token <PERSONAL_ACCESS_TOKEN>)');

      if (missing.length > 0) {
        throw new Error(
          `[ONBOARDING: MISSING CONNECTION DETAILS FOR AZURE DEVOPS]\n` +
            `Provided so far: ${provided.length > 0 ? provided.join(', ') : 'none'}\n` +
            `Missing required connection details:\n` +
            missing.map((m) => `  ✗ ${m}`).join('\n') +
            `\n\nAI Agent Action: Ask the user for the missing field(s) above, then re-run 'tkt setup'.`
        );
      }
    }

    // Step 3: Verify Connection
    const client = createTempProvider(provider, baseUrl, user, token, authType, 'TEMP', workspaceDir);
    if (options.format !== 'json') {
      console.log(`\n⏳ Verifying ${provider.toUpperCase()} connection to ${baseUrl}...`);
    }
    const me = await client.testConnection();
    if (options.format !== 'json') {
      console.log(`✓ Authenticated as: ${me.displayName}${me.email ? ` (${me.email})` : ''}`);
    }

    // Step 4: Select Project
    let selectedProject = options.project || '';
    if (!selectedProject) {
      const projects = await client.listProjects();
      if (projects.length === 0) {
        throw new Error(`No accessible projects found in ${baseUrl}.`);
      }
      if (!isInteractive && projects.length === 1) {
        // Auto-select if there is only 1 accessible project in the account
        selectedProject = projects[0].key;
        if (options.format !== 'json') {
          console.log(`✓ Auto-selected the only project in account: ${projects[0].key} (${projects[0].name})`);
        }
      } else if (!isInteractive && projects.length > 1) {
        const projListStr = projects
          .map((p) => `  • --project "${p.key}"  (${p.name})`)
          .join('\n');
        throw new Error(
          `[ONBOARDING: PROJECT SELECTION REQUIRED]\n` +
            `Found ${projects.length} accessible projects in ${baseUrl}:\n${projListStr}\n\n` +
            `AI Agent Action: Ask the user which project to connect to, then re-run with --project "<PROJECT_KEY>".`
        );
      } else {
        if (options.format !== 'json') {
          console.log(`\n📁 Found ${projects.length} accessible project(s):`);
          projects.slice(0, 25).forEach((p, idx) => {
            console.log(`  [${idx + 1}] ${p.key.padEnd(16)} — ${p.name}`);
          });
        }
        const projChoice = await ask(
          '\n6. Select Project (enter number or Project Key/Name)',
          projects[0].key
        );
        const numIdx = Number(projChoice);
        if (!Number.isNaN(numIdx) && numIdx >= 1 && numIdx <= projects.length) {
          selectedProject = projects[numIdx - 1].key;
        } else {
          selectedProject = projChoice;
        }
      }
    }

    // Step 5: MANDATORY BOARD SELECTION (Supports Single or Multi-Board on the same account!)
    const boards = await client.listBoards(selectedProject);
    const chosenBoards: BoardSummary[] = [];

    const resolveBoardSpec = (spec: string): BoardSummary => {
      const target = spec.trim().toLowerCase();
      const numIdx = Number(target);
      if (!Number.isNaN(numIdx) && numIdx >= 1 && numIdx <= boards.length) {
        const exactById = boards.find((b) => b.id.toLowerCase() === target);
        if (!exactById) {
          return boards[numIdx - 1];
        }
      }
      const found = boards.find(
        (b) =>
          b.id.toLowerCase() === target ||
          b.name.toLowerCase() === target ||
          b.name.toLowerCase().includes(target)
      );
      if (found) return found;
      return {
        id: spec.trim(),
        name: `${selectedProject} Board #${spec.trim()}`,
        type: provider === 'jira' ? 'kanban' : 'Stories',
        projectKey: selectedProject,
      };
    };

    if (options.board) {
      const specs = options.board
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const spec of specs) {
        chosenBoards.push(resolveBoardSpec(spec));
      }
    } else if (isInteractive) {
      console.log(
        `\n📋 Available Boards in project '${selectedProject}' (${boards.length} found):`
      );
      console.log('-'.repeat(76));
      boards.forEach((b, idx) => {
        console.log(
          `  [${idx + 1}] ${b.name.padEnd(38)} (ID: ${b.id}, Type: ${b.type})`
        );
      });
      console.log('-'.repeat(76));

      const boardAns = await ask(
        `\n7. REQUIRED: Choose Board(s) to connect (enter number(s) e.g. "1" or "1,2", Board ID(s), or Board Name(s))`,
        '1'
      );
      const specs = boardAns
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const spec of specs) {
        chosenBoards.push(resolveBoardSpec(spec));
      }
    } else {
      // Non-interactive mode without --board: list the boards and error clearly so AI/user explicitly chooses!
      const boardListStr = boards
        .map((b) => `  • --board "${b.id}"  (${b.name} [${b.type}])`)
        .join('\n');
      throw new Error(
        `[ONBOARDING: BOARD SELECTION REQUIRED]\n` +
          `Found ${boards.length} board(s) in project '${selectedProject}':\n${boardListStr}\n\n` +
          `AI Agent Action: Present these boards to the user and ask which board(s) to connect to, then re-run:\n` +
          `  tkt setup --provider ${provider} --project "${selectedProject}" --board "<BOARD_ID_1>,<BOARD_ID_2>" --non-interactive`
      );
    }

    const createdProfiles: TktProfile[] = [];
    const contextMdPaths: string[] = [];

    for (let i = 0; i < chosenBoards.length; i++) {
      const chosenBoard = chosenBoards[i];
      let alias = slugifyBoardAlias(
        selectedProject,
        chosenBoard,
        i,
        chosenBoards.length,
        options.profileName
      );
      if (isInteractive && chosenBoards.length === 1 && !options.profileName) {
        alias = await ask(
          `8. Profile alias for board '${chosenBoard.name}'`,
          alias
        );
      }

      if (options.format !== 'json') {
        console.log(
          `\n🔍 Introspecting board '${chosenBoard.name}' (ID: ${chosenBoard.id}) [Tier 1 Schema + Tier 2 Empirical Mining]...`
        );
      }

      const boardConfig = await client.introspectBoard(selectedProject, chosenBoard);
      if (options.requiredLabels && options.requiredLabels.length > 0) {
        const merged = new Set([
          ...(boardConfig.placement.requiredLabels ?? []),
          ...options.requiredLabels,
        ]);
        boardConfig.placement.requiredLabels = Array.from(merged);
      }

      const profile: TktProfile = {
        name: alias,
        provider,
        baseUrl,
        project: selectedProject,
        authType,
        envVars:
          provider === 'jira'
            ? { url: 'JIRA_URL', user: 'JIRA_USER', token: 'JIRA_TOKEN' }
            : { url: 'ADO_ORG_URL', user: 'ADO_USER', token: 'ADO_TOKEN' },
        board: boardConfig,
        governance: {
          forbidDelete: true,
          requireConfirmation: true,
          enforceBoardSchema: true,
          autoApplyBoardPlacement: true,
          auditLog: true,
        },
      };

      upsertProfile(profile, i === 0 && !existingCfg?.defaultProfile, workspaceDir);
      const contextMdPath = generateBoardContextMarkdown(profile, workspaceDir);
      createdProfiles.push(profile);
      contextMdPaths.push(contextMdPath);
    }

    // Scaffold .agents/ harness & .gitignore in fresh workspaces
    scaffoldWorkspaceAgentHarness(workspaceDir);

    const updatedCfg = loadWorkspaceConfig(workspaceDir);
    const indexMdPath = updatedCfg
      ? generateMultiBoardIndexMarkdown(updatedCfg, workspaceDir)
      : '.tkt/boards/INDEX.md';

    const primaryProfile = createdProfiles[0];

    if (options.format === 'json') {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'setup',
            provider,
            baseUrl,
            project: selectedProject,
            profileName: primaryProfile.name,
            connectedBoard: {
              id: primaryProfile.board.id,
              name: primaryProfile.board.name,
              type: primaryProfile.board.boardType,
              archetype: primaryProfile.board.archetype,
              boardUrl: primaryProfile.board.boardUrl,
              columns: primaryProfile.board.columns,
              placement: primaryProfile.board.placement,
              issueTypes: primaryProfile.board.issueTypes.map((it) => it.name),
            },
            connectedBoards: createdProfiles.map((p) => ({
              profileName: p.name,
              id: p.board.id,
              name: p.board.name,
              type: p.board.boardType,
              archetype: p.board.archetype,
              boardUrl: p.board.boardUrl,
              routedIssueTypes: p.board.placement.routedIssueTypes,
              requiredLabels: p.board.placement.requiredLabels,
              defaultAreaPath: p.board.placement.defaultAreaPath,
            })),
            configPath: '.tkt/config.json',
            boardContextMarkdown: contextMdPaths[0],
            boardContextMarkdowns: contextMdPaths,
            multiBoardIndexMarkdown: indexMdPath,
          },
          null,
          2
        )
      );
    } else {
      console.log('\n✓ Single-Account Board connection & schema introspection complete!');
      console.log(`  • Account:             ${provider.toUpperCase()} (${baseUrl})`);
      console.log(`  • Connected Boards:    ${createdProfiles.length} in this run (${Object.keys(updatedCfg?.profiles ?? {}).length} total in workspace)`);
      for (const p of createdProfiles) {
        console.log(`    - [${p.name}] ${p.board.name} (ID: ${p.board.id}) -> .tkt/boards/${p.name}.md`);
        console.log(`      Columns: ${p.board.columns.map((c) => c.columnName).join(' -> ')}`);
        if (p.board.placement.requiredLabels?.length) {
          console.log(`      Auto Labels: ${p.board.placement.requiredLabels.join(', ')}`);
        }
        if (p.board.placement.routedIssueTypes?.length) {
          console.log(`      Routed Issue Types: ${p.board.placement.routedIssueTypes.join(', ')}`);
        }
        if (p.board.placement.defaultAreaPath) {
          console.log(`      Default Area Path: ${p.board.placement.defaultAreaPath}`);
        }
      }
      console.log(`  • Multi-Board Index:   .tkt/boards/INDEX.md`);
      console.log('='.repeat(76));
    }

    return primaryProfile;
  } finally {
    rl?.close();
  }
}

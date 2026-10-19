import { createInterface } from 'node:readline/promises';
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

function slugifyBoardAlias(project: string, board: BoardSummary, index: number, total: number, explicitProfile?: string): string {
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

function createTempProvider(
  providerType: ProviderType,
  baseUrl: string,
  user: string | undefined,
  token: string,
  authType: 'cloud' | 'datacenter' | 'pat' | 'bearer',
  project: string = 'TEMP'
): TrackerProvider {
  const creds = resolveCredentials(providerType, process.cwd(), {
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
      const choice = (
        await ask('1. Select issue tracker provider (1 = Jira, 2 = Azure DevOps)', '1')
      ).toLowerCase();
      provider =
        choice === '2' || choice === 'ado' || choice.includes('azure')
          ? 'ado'
          : 'jira';
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
          (await ask('4. Atlassian User Email', existingUser));
      }
      token =
        token ||
        (await ask(
          `5. Jira API Token ${existingToken ? '(Press Enter to keep existing token in .env)' : ''}`,
          existingToken
        ));

      upsertDotEnvValues(
        {
          JIRA_URL: baseUrl,
          ...(user ? { JIRA_USER: user } : {}),
          JIRA_TOKEN: token,
          JIRA_AUTH_TYPE: authType,
        },
        workspaceDir
      );
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

      upsertDotEnvValues(
        {
          ADO_ORG_URL: baseUrl,
          ...(user ? { ADO_USER: user } : {}),
          ADO_TOKEN: token,
        },
        workspaceDir
      );
    }

    // Step 3: Verify Connection
    const client = createTempProvider(provider, baseUrl, user, token, authType);
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

    // Step 5: MANDATORY BOARD SELECTION (Supports Single or Multi-Board on the same account!)
    const boards = await client.listBoards(selectedProject);
    const chosenBoards: BoardSummary[] = [];

    const resolveBoardSpec = (spec: string): BoardSummary => {
      const target = spec.trim().toLowerCase();
      const numIdx = Number(target);
      if (!Number.isNaN(numIdx) && numIdx >= 1 && numIdx <= boards.length) {
        // Only treat as 1-based index if no board has that exact ID
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
        `Board selection is required during setup! Found ${boards.length} board(s) in project '${selectedProject}':\n${boardListStr}\n\nRe-run with one or multiple comma-separated boards:\n  tkt setup --provider ${provider} --project "${selectedProject}" --board "<BOARD_ID_1>,<BOARD_ID_2>"`
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

      // Set the first connected board in this run as default if no default exists yet
      upsertProfile(profile, i === 0 && !existingCfg?.defaultProfile, workspaceDir);
      const contextMdPath = generateBoardContextMarkdown(profile, workspaceDir);
      createdProfiles.push(profile);
      contextMdPaths.push(contextMdPath);
    }

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

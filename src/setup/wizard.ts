import { createInterface } from 'node:readline/promises';
import {
  generateBoardContextMarkdown,
  loadDotEnv,
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
  /** Board ID or Board Name to connect to */
  board?: string;
  requiredLabels?: string[];
  nonInteractive?: boolean;
  format?: OutputFormat;
  workspaceDir?: string;
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
      console.log('🛠️  tkt — Unified Jira & Azure DevOps Connection + Board Setup Wizard');
      console.log('='.repeat(76));
    }

    // Step 1: Choose Provider (jira | ado)
    let provider: ProviderType | undefined = options.provider;
    if (!provider) {
      const choice = (
        await ask('1. Select issue tracker provider (1 = Jira, 2 = Azure DevOps)', '1')
      ).toLowerCase();
      provider =
        choice === '2' || choice === 'ado' || choice.includes('azure')
          ? 'ado'
          : 'jira';
    }

    // Step 2: Profile Name
    const defaultProfileName = options.profileName || (provider === 'jira' ? 'jira-main' : 'ado-main');
    const profileName = await ask('2. Profile name for this board connection', defaultProfileName);

    // Step 3: Credentials & Base URL
    let baseUrl = options.baseUrl || '';
    let user = options.user || '';
    let token = options.token || '';
    let authType: 'cloud' | 'datacenter' | 'pat' | 'bearer' =
      options.authType || (provider === 'jira' ? 'cloud' : 'pat');

    if (provider === 'jira') {
      const existingUrl = env.JIRA_URL || env.ATLASSIAN_URL || '';
      const existingUser = env.JIRA_USER || env.ATLASSIAN_USER_EMAIL || '';
      const existingToken = env.JIRA_TOKEN || env.ATLASSIAN_API_TOKEN || '';

      baseUrl = (
        baseUrl ||
        (await ask('3. Jira Base URL (e.g. https://your-org.atlassian.net)', existingUrl))
      ).replace(/\/+$/, '');

      const authChoice = (
        await ask('4. Jira Auth Type (cloud = Email + API Token, datacenter = Bearer PAT)', authType)
      ).toLowerCase();
      authType = authChoice.startsWith('d') || authChoice === 'bearer' ? 'datacenter' : 'cloud';

      if (authType === 'cloud') {
        user =
          user ||
          (await ask('5. Atlassian User Email', existingUser));
      }
      token =
        token ||
        (await ask(
          `6. Jira API Token ${existingToken ? '(Press Enter to keep existing token in .env)' : ''}`,
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
      const existingUrl = env.ADO_ORG_URL || '';
      const existingUser = env.ADO_USER || '';
      const existingToken = env.ADO_TOKEN || env.AZURE_TOKEN || '';

      baseUrl = (
        baseUrl ||
        (await ask(
          '3. Azure DevOps Organization URL (e.g. https://dev.azure.com/your-org)',
          existingUrl
        ))
      ).replace(/\/+$/, '');
      user =
        user ||
        (await ask('4. Azure DevOps User Email (optional, for display)', existingUser));
      token =
        token ||
        (await ask(
          `5. Azure DevOps Personal Access Token (PAT) ${existingToken ? '(Press Enter to keep existing token in .env)' : ''}`,
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

    // Step 4: Verify Connection
    const client = createTempProvider(provider, baseUrl, user, token, authType);
    if (options.format !== 'json') {
      console.log(`\n⏳ Verifying ${provider.toUpperCase()} connection to ${baseUrl}...`);
    }
    const me = await client.testConnection();
    if (options.format !== 'json') {
      console.log(`✓ Authenticated as: ${me.displayName}${me.email ? ` (${me.email})` : ''}`);
    }

    // Step 5: Select Project
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
        '\n7. Select Project (enter number or Project Key/Name)',
        projects[0].key
      );
      const numIdx = Number(projChoice);
      if (!Number.isNaN(numIdx) && numIdx >= 1 && numIdx <= projects.length) {
        selectedProject = projects[numIdx - 1].key;
      } else {
        selectedProject = projChoice;
      }
    }

    // Step 6: MANDATORY BOARD SELECTION (User/AI must choose which board to connect to!)
    const boards = await client.listBoards(selectedProject);
    let chosenBoard: BoardSummary | undefined;

    if (options.board) {
      const target = options.board.trim().toLowerCase();
      chosenBoard = boards.find(
        (b) =>
          b.id.toLowerCase() === target ||
          b.name.toLowerCase() === target ||
          b.name.toLowerCase().includes(target)
      );
      if (!chosenBoard) {
        // Allow explicit custom board ID if not returned in first page
        chosenBoard = {
          id: options.board.trim(),
          name: `${selectedProject} Board #${options.board.trim()}`,
          type: provider === 'jira' ? 'kanban' : 'Stories',
          projectKey: selectedProject,
        };
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
        `\n8. REQUIRED: Choose which Board to connect to (enter [1-${boards.length}], Board ID, or Board Name)`,
        '1'
      );
      const bIdx = Number(boardAns);
      if (!Number.isNaN(bIdx) && bIdx >= 1 && bIdx <= boards.length) {
        chosenBoard = boards[bIdx - 1];
      } else {
        chosenBoard =
          boards.find(
            (b) =>
              b.id.toLowerCase() === boardAns.toLowerCase() ||
              b.name.toLowerCase().includes(boardAns.toLowerCase())
          ) ?? boards[0];
      }
    } else {
      // Non-interactive mode without --board: list the boards and error clearly so AI/user explicitly chooses!
      const boardListStr = boards
        .map((b) => `  • --board "${b.id}"  (${b.name} [${b.type}])`)
        .join('\n');
      throw new Error(
        `Board selection is required during setup! Found ${boards.length} board(s) in project '${selectedProject}':\n${boardListStr}\n\nRe-run with: tkt setup --provider ${provider} --project "${selectedProject}" --board "<BOARD_ID>"`
      );
    }

    if (options.format !== 'json') {
      console.log(
        `\n🔍 Introspecting board '${chosenBoard.name}' (ID: ${chosenBoard.id})...`
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
      name: profileName,
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

    upsertProfile(profile, true, workspaceDir);
    const contextMdPath = generateBoardContextMarkdown(profile, workspaceDir);

    if (options.format === 'json') {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'setup',
            profileName: profile.name,
            provider: profile.provider,
            project: profile.project,
            connectedBoard: {
              id: profile.board.id,
              name: profile.board.name,
              type: profile.board.boardType,
              archetype: profile.board.archetype,
              boardUrl: profile.board.boardUrl,
              columns: profile.board.columns,
              placement: profile.board.placement,
              issueTypes: profile.board.issueTypes.map((it) => it.name),
            },
            configPath: '.tkt/config.json',
            boardContextMarkdown: contextMdPath,
          },
          null,
          2
        )
      );
    } else {
      console.log('✓ Board connection & schema introspection complete!');
      console.log(`  • Saved Profile:       ${profile.name} (.tkt/config.json)`);
      console.log(`  • Connected Board:     ${profile.board.name} (ID: ${profile.board.id})`);
      console.log(`  • Board URL:           ${profile.board.boardUrl}`);
      console.log(
        `  • Discovered Columns:  ${profile.board.columns.map((c) => c.columnName).join(' -> ')}`
      );
      if (profile.board.placement.requiredLabels?.length) {
        console.log(
          `  • Auto Board Labels:   ${profile.board.placement.requiredLabels.join(', ')}`
        );
      }
      if (profile.board.placement.defaultAreaPath) {
        console.log(
          `  • Default Area Path:   ${profile.board.placement.defaultAreaPath}`
        );
      }
      console.log(`  • AI Board Context:    .tkt/boards/${profile.name}.md`);
      console.log('='.repeat(76));
    }

    return profile;
  } finally {
    rl?.close();
  }
}

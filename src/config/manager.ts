import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureWorkspaceHome, getWorkspacePath } from './paths.ts';
import type {
  ConnectedBoardConfig,
  ProviderType,
  TktProfile,
  TktWorkspaceConfig,
} from '../types.ts';

export interface ResolvedCredentials {
  provider: ProviderType;
  baseUrl: string;
  user?: string;
  token: string;
  authHeader: string;
  authType: 'cloud' | 'datacenter' | 'pat' | 'bearer';
}

/**
 * Lightweight zero-dependency .env parser
 */
function readDotEnv(envPath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(envPath)) {
    return values;
  }
  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    values[key] = val;
  }
  return values;
}

export function loadDotEnv(workspaceDir: string = process.cwd()): Record<string, string> {
  return {
    ...readDotEnv(join(workspaceDir, '.env')),
    ...readDotEnv(getWorkspacePath(workspaceDir, '.env')),
  };
}

/**
 * Windows ignores POSIX modes. Grant the current user full control and drop everything
 * inherited from the folder (shared Users/Authenticated Users access), the equivalent of 0600.
 * Explicit SYSTEM/Administrators entries Windows may add stay, as root keeps access on Unix.
 */
function restrictToCurrentUser(path: string): void {
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, { encoding: 'utf-8', windowsHide: true });
  const sid = run('whoami', ['/user', '/fo', 'csv', '/nh']).stdout?.match(/S-1-[\d-]+/)?.[0];
  // Drop inherited entries only once the user's own entry exists, so the file stays readable.
  const granted = sid !== undefined && run('icacls', [path, '/grant:r', `*${sid}:(F)`]).status === 0;
  if (!granted || run('icacls', [path, '/inheritance:r']).status !== 0) {
    console.error(`Warning: could not restrict ${path} to the current user. Check its permissions with icacls.`);
  }
}

export function upsertDotEnvValues(
  updates: Record<string, string>,
  workspaceDir: string = process.cwd()
): string {
  const envPath = join(ensureWorkspaceHome(workspaceDir), '.env');
  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split(/\r?\n/);
  }
  const updatedKeys = new Set<string>();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!updatedKeys.has(k) && v !== undefined) {
      newLines.push(`${k}=${v}`);
    }
  }

  writeFileSync(envPath, newLines.join('\n').trimEnd() + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(envPath, 0o600);
  if (process.platform === 'win32') restrictToCurrentUser(envPath);
  return envPath;
}

export function getConfigPath(workspaceDir: string = process.cwd()): string {
  return getWorkspacePath(workspaceDir, 'config.json');
}

export function loadWorkspaceConfig(
  workspaceDir: string = process.cwd()
): TktWorkspaceConfig | null {
  const cfgPath = getConfigPath(workspaceDir);
  if (!existsSync(cfgPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8')) as TktWorkspaceConfig;
  } catch (err) {
    throw new Error(`Failed to parse ${cfgPath}: ${(err as Error).message}`);
  }
}

export function saveWorkspaceConfig(
  config: TktWorkspaceConfig,
  workspaceDir: string = process.cwd()
): string {
  const cfgPath = getConfigPath(workspaceDir);
  ensureWorkspaceHome(workspaceDir);
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return cfgPath;
}

/**
 * Adds or updates a connected board in `.tktcraft/config.json`.
 * Enforces the Single-Account Multi-Board rule: all boards in a workspace share the
 * same provider (`jira` OR `ado`) and account (`baseUrl`). If the workspace was previously
 * connected to a different provider, it resets cleanly to the new provider account.
 */
export function upsertProfile(
  profile: TktProfile,
  setDefault: boolean = true,
  workspaceDir: string = process.cwd()
): TktWorkspaceConfig {
  let existing = loadWorkspaceConfig(workspaceDir);

  if (
    !existing ||
    (existing.provider && existing.provider !== profile.provider)
  ) {
    existing = {
      version: 1 as const,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      defaultProfile: profile.name,
      profiles: {},
    };
  } else {
    existing.provider = profile.provider;
    existing.baseUrl = profile.baseUrl;
  }

  existing.profiles[profile.name] = profile;
  if (setDefault || !existing.defaultProfile || !existing.profiles[existing.defaultProfile]) {
    existing.defaultProfile = profile.name;
  }

  saveWorkspaceConfig(existing, workspaceDir);
  generateBoardContextMarkdown(profile, workspaceDir);
  generateMultiBoardIndexMarkdown(existing, workspaceDir);
  return existing;
}

/**
 * Generates `.tktcraft/boards/INDEX.md` — a master multi-board routing map showing all
 * connected boards in the same Jira or Azure DevOps account and how work routes between them.
 */
export function generateMultiBoardIndexMarkdown(
  config: TktWorkspaceConfig,
  workspaceDir: string = process.cwd()
): string {
  const boardsDir = join(ensureWorkspaceHome(workspaceDir), 'boards');
  mkdirSync(boardsDir, { recursive: true });
  const indexPath = join(boardsDir, 'INDEX.md');
  const profiles = Object.values(config.profiles);
  if (profiles.length === 0) return indexPath;

  const providerName =
    (config.provider ?? profiles[0].provider) === 'jira' ? 'Jira' : 'Azure DevOps';
  const baseUrl = config.baseUrl ?? profiles[0].baseUrl;

  const rows = profiles
    .map((p) => {
      const b = p.board;
      const isDef = p.name === config.defaultProfile ? ' **(Default)**' : '';
      const routedTypes =
        b.placement.routedIssueTypes?.length
          ? b.placement.routedIssueTypes.map((t) => `\`${t}\``).join(', ')
          : b.issueTypes.slice(0, 4).map((t) => `\`${t.name}\``).join(', ') || 'All';
      const placementRule =
        b.placement.requiredLabels?.length
          ? `Labels: ${b.placement.requiredLabels.map((l) => `\`${l}\``).join(', ')}`
          : b.placement.defaultAreaPath
            ? `AreaPath: \`${b.placement.defaultAreaPath}\``
            : `Project: \`${p.project}\``;
      return `| \`${p.name}\`${isDef} | **[${b.name}](${b.boardUrl})** (\`#${b.id}\`) | \`${b.archetype}\` | ${routedTypes} | ${placementRule} | [${p.name}.md](./${p.name}.md) |`;
    })
    .join('\n');

  const md = `# Multi-Board Workspace Map (${providerName} — \`${baseUrl}\`)

> Auto-generated by \`tktcraft\`. This workspace is connected to **${profiles.length} board(s)** in the same ${providerName} account.
> Both humans and AI agents can target a specific board via \`--board <alias|id>\` or let \`tktcraft\` auto-route by Issue Type, Label, or AreaPath.

## Connected Boards & Cross-Board Routing Table

| Board Alias | Board Name & ID | Archetype | Routed Issue / Work-Item Types | Auto-Placement Rule | Full Board Guide |
| :--- | :--- | :--- | :--- | :--- | :--- |
${rows}
`;

  writeFileSync(indexPath, md, 'utf-8');
  return indexPath;
}

/**
 * Writes a comprehensive 3-Tier `board.md` reference guide in `.tktcraft/boards/<profile>.md`
 * combining Tier 1 (Formal API Schema) and Tier 2 (Empirical Team Ticket Conventions).
 */
export function generateBoardContextMarkdown(
  profile: TktProfile,
  workspaceDir: string = process.cwd()
): string {
  const boardsDir = join(ensureWorkspaceHome(workspaceDir), 'boards');
  mkdirSync(boardsDir, { recursive: true });
  const mdPath = join(boardsDir, `${profile.name}.md`);
  const b = profile.board;

  const colRows = b.columns
    .map((c) => {
      const wip =
        c.wipMax !== undefined || c.wipMin !== undefined
          ? `${c.wipMin ?? 0}–${c.wipMax ?? '∞'}`
          : '-';
      const dod = c.definitionOfDone
        ? c.definitionOfDone.replace(/\n+/g, ' ').slice(0, 80)
        : '-';
      return `| **${c.columnName}** | ${c.statuses.map((s) => `\`${s}\``).join(', ')} | \`${c.category ?? 'in_progress'}\` | ${wip} | ${dod} |`;
    })
    .join('\n');

  const typeSections = b.issueTypes
    .map((it) => {
      const reqFields = it.fields.filter((f) => f.required);
      const optFields = it.fields.filter((f) => !f.required);
      const dropdownLines = it.fields
        .filter((f) => f.allowedValues && f.allowedValues.length > 0)
        .map(
          (f) =>
            `  - \`${f.key}\` (**${f.name}**) options: ${f.allowedValues!
              .slice(0, 10)
              .map((av) => `\`${av.name}\`${av.id ? ` (id:${av.id})` : ''}`)
              .join(', ')}`
        );

      return [
        `### ${it.name}${it.subtask ? ' (Sub-task)' : ''}`,
        it.description ? `> ${it.description}` : '',
        it.acceptanceCriteriaField
          ? `- **Dedicated Acceptance Criteria Field**: \`${it.acceptanceCriteriaField}\``
          : '',
        it.reproStepsField
          ? `- **Dedicated Repro Steps Field**: \`${it.reproStepsField}\``
          : '',
        reqFields.length > 0
          ? `- **Required Fields**: ${reqFields.map((f) => `\`${f.key}\` (${f.name})`).join(', ')}`
          : '- **Required Fields**: `summary` / `title`',
        optFields.length > 0
          ? `- **Board/Custom Fields**: ${optFields.slice(0, 10).map((f) => `\`${f.key}\` (${f.name})`).join(', ')}`
          : '',
        ...dropdownLines,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const placementLines: string[] = [];
  if (b.placement.routedIssueTypes?.length) {
    placementLines.push(
      `- **Routed Issue Types for This Board**: ${b.placement.routedIssueTypes.map((t) => `\`${t}\``).join(', ')}`
    );
  }
  if (b.placement.requiredLabels?.length) {
    placementLines.push(
      `- **Auto-Applied Board Labels/Tags**: ${b.placement.requiredLabels.map((l) => `\`${l}\``).join(', ')}`
    );
  }
  if (b.placement.filterQuery) {
    placementLines.push(`- **Board Filter Query**: \`${b.placement.filterQuery}\``);
  }
  if (b.placement.defaultAreaPath) {
    placementLines.push(`- **Default Area Path**: \`${b.placement.defaultAreaPath}\``);
  }
  if (b.placement.defaultIterationPath) {
    placementLines.push(`- **Default Iteration Path**: \`${b.placement.defaultIterationPath}\``);
  }
  if (b.placement.activeSprintName) {
    placementLines.push(
      `- **Active Sprint**: \`${b.placement.activeSprintName}\` (ID: \`${b.placement.activeSprintId}\`)${b.placement.activeSprintGoal ? ` — Goal: *"${b.placement.activeSprintGoal}"*` : ''}`
    );
  }

  // Tier 2 Empirical Conventions Section
  const conv = b.conventions;
  let empiricalSection =
    '*(No existing tickets sampled yet — run `tktcraft discover` with live credentials to mine team conventions)*';
  if (conv && conv.sampledTicketCount > 0) {
    const typeDist = Object.entries(conv.issueTypeCounts)
      .map(
        ([t, count]) =>
          `\`${t}\` (${Math.round((count / conv.sampledTicketCount) * 100)}% — ${count}/${conv.sampledTicketCount})`
      )
      .join(', ');
    const vocab = conv.activeLabelsVocabulary
      .slice(0, 15)
      .map((v) => `\`${v.label}\` (${v.count})`)
      .join(', ');
    const examples = conv.sampleSummaries.map((s) => `  - \`${s}\``).join('\n');
    const headings = conv.commonDescriptionHeadings.map((h) => `\`${h}\``).join(', ');

    empiricalSection = [
      `- **Sampled Board Tickets**: ${conv.sampledTicketCount} most recent tickets`,
      `- **Observed Issue Type Breakdown**: ${typeDist || 'N/A'}`,
      `- **Detected Summary Naming Pattern**: ${conv.detectedTitlePattern || 'Standard sentence case'}`,
      conv.parentLinkPercentage !== undefined
        ? `- **Parent / Epic Linking Rate**: ${conv.parentLinkPercentage}% of tickets link to a parent`
        : '',
      vocab
        ? `- **Existing Board Label/Tag Vocabulary (Reuse These)**: ${vocab}`
        : '- **Existing Board Label/Tag Vocabulary**: *(None observed)*',
      headings
        ? `- **Common Description Section Headings**: ${headings}`
        : '',
      conv.activeAssignees.length
        ? `- **Active Board Contributors**: ${conv.activeAssignees.slice(0, 10).join(', ')}`
        : '',
      examples ? `- **Real Ticket Summary Examples (Few-Shot Reference)**:\n${examples}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const md = `# Connected Board Guide: ${b.name} (\`${profile.name}\`)

> Auto-generated by \`tktcraft\` on ${b.syncedAt}.
> Combines **Tier 1 (Formal Board & Field API Schema)** and **Tier 2 (Empirical Team Workflow Mining)**.

## 1. Board Identity & Deep-Links
- **Board Alias / Profile**: \`${profile.name}\`
- **Provider**: \`${profile.provider === 'jira' ? 'Jira' : 'Azure DevOps'}\`
- **Account URL**: \`${profile.baseUrl}\`
- **Project**: \`${profile.project}\`
- **Board Name**: **${b.name}** (ID: \`${b.id}\`)
- **Board Type / Archetype**: \`${b.boardType}\` / \`${b.archetype}\`
- **Board View URL**: ${b.boardUrl}
- **Selected Ticket URL Pattern**: \`${b.selectedTicketBoardUrlTemplate}\`

## 2. Board Placement & Cross-Board Routing Rules
${placementLines.length ? placementLines.join('\n') : '- Standard project placement (`project = ' + profile.project + '`).'}

## 3. Board Column <-> Workflow Status Mapping
| Board Column | Underlying Status / State(s) | Category | WIP Limit | Definition of Done |
| :--- | :--- | :--- | :--- | :--- |
${colRows || '| *(Default)* | `To Do`, `In Progress`, `Done` | `in_progress` | - | - |'}

## 4. Empirical Team Conventions (Mined from Board Tickets)
${empiricalSection}

## 5. Issue / Work Item Types & Field Schemas
${typeSections || '*(Standard issue types)*'}
`;

  writeFileSync(mdPath, md, 'utf-8');
  return mdPath;
}

/**
 * Resolves the target board profile from the workspace's Multi-Board registry (`Jira+Jira` or `ADO+ADO`) based on:
 * 1. Explicit `--board <alias|id|name>` or `--profile <alias>`
 * 2. Smart Cross-Board Auto-Routing by `issueTypeHint`, `labelsHint`, or `areaPathHint`
 * 3. `TKT_DEFAULT_PROFILE` or `config.defaultProfile`
 */
export function resolveActiveProfile(
  options: {
    profileName?: string;
    boardHint?: string;
    provider?: ProviderType;
    ticketKeyHint?: string;
    issueTypeHint?: string;
    labelsHint?: string[];
    areaPathHint?: string;
    workspaceDir?: string;
  } = {}
): TktProfile {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const config = loadWorkspaceConfig(workspaceDir);
  const env = { ...loadDotEnv(workspaceDir), ...process.env };

  if (config && Object.keys(config.profiles).length > 0) {
    const allProfiles = Object.values(config.profiles);

    // 1. Explicit --profile or --board (matches profile alias, board ID, or board name)
    const explicitSelector = options.boardHint || options.profileName;
    if (explicitSelector) {
      const selLower = explicitSelector.trim().toLowerCase();
      if (config.profiles[explicitSelector]) {
        return config.profiles[explicitSelector];
      }
      const matchedByBoard = allProfiles.find(
        (p) =>
          p.name.toLowerCase() === selLower ||
          p.board.id.toLowerCase() === selLower ||
          p.board.name.toLowerCase() === selLower ||
          p.board.name.toLowerCase().includes(selLower)
      );
      if (matchedByBoard) return matchedByBoard;

      const available = allProfiles
        .map((p) => `${p.name} (${p.board.name} #${p.board.id})`)
        .join(', ');
      throw new Error(
        `Board or profile '${explicitSelector}' not found in .tktcraft/config.json. Connected boards: ${available}`
      );
    }

    // 2. Smart Cross-Board Auto-Routing when multiple boards are connected in the same account
    if (allProfiles.length > 1) {
      // 2a. Match by required labels (e.g. "business_req_for_agent" or "eae_infrastructure")
      if (options.labelsHint && options.labelsHint.length > 0) {
        const lowerLabels = options.labelsHint.map((l) => l.toLowerCase());
        const labelMatch = allProfiles.find((p) =>
          p.board.placement.requiredLabels?.some((req) =>
            lowerLabels.includes(req.toLowerCase())
          )
        );
        if (labelMatch) return labelMatch;
      }

      // 2b. Match by Azure DevOps AreaPath
      if (options.areaPathHint) {
        const areaLower = options.areaPathHint.toLowerCase();
        const areaMatch = allProfiles.find(
          (p) =>
            p.board.placement.defaultAreaPath &&
            areaLower.startsWith(p.board.placement.defaultAreaPath.toLowerCase())
        );
        if (areaMatch) return areaMatch;
      }

      // 2c. Match by Issue Type (e.g. "Initiative" routes to Discovery board #4893; "Story" routes to Implementation board #4887)
      if (options.issueTypeHint) {
        const typeLower = options.issueTypeHint.trim().toLowerCase();
        const explicitRouteMatch = allProfiles.find((p) =>
          p.board.placement.routedIssueTypes?.some(
            (rt) => rt.toLowerCase() === typeLower
          )
        );
        if (explicitRouteMatch) return explicitRouteMatch;

        // Also check empirical ticket counts (if one board strongly owns this issue type)
        const empiricalMatch = allProfiles.find((p) => {
          const counts = p.board.conventions?.issueTypeCounts;
          if (!counts) return false;
          return Object.keys(counts).some(
            (k) => k.toLowerCase() === typeLower && counts[k] > 0
          );
        });
        if (empiricalMatch) return empiricalMatch;

        // Archetype fallback: "Initiative" -> discovery board; "Epic" -> roadmap/discovery board
        if (typeLower === 'initiative') {
          const disc = allProfiles.find((p) => p.board.archetype === 'discovery');
          if (disc) return disc;
        }
      }
    }

    // 3. Match by ticket key prefix if multi-project within same Jira account
    if (options.ticketKeyHint) {
      const isJiraStyle = /^[A-Z][A-Z0-9_]+-\d+$/i.test(options.ticketKeyHint.trim());
      if (isJiraStyle) {
        const prefix = options.ticketKeyHint.split('-')[0].toUpperCase();
        const defaultProf = config.profiles[config.defaultProfile];
        if (defaultProf && defaultProf.project.toUpperCase() === prefix) {
          return defaultProf;
        }
        const exactProj = allProfiles.find(
          (p) => p.project.toUpperCase() === prefix
        );
        if (exactProj) return exactProj;
      }
    }

    const envDefault = env.TKT_DEFAULT_PROFILE;
    if (envDefault && config.profiles[envDefault]) {
      return config.profiles[envDefault];
    }

    if (config.defaultProfile && config.profiles[config.defaultProfile]) {
      return config.profiles[config.defaultProfile];
    }

    return allProfiles[0];
  }

  // Fallback ephemeral profile from .env if `tkt setup` hasn't been run yet
  const provider: ProviderType =
    options.provider ??
    (env.ADO_TOKEN && !env.JIRA_TOKEN && !env.ATLASSIAN_API_TOKEN ? 'ado' : 'jira');

  if (provider === 'ado') {
    const baseUrl = (
      env.ADO_ORG_URL ||
      env.ISSUE_TRACKER__BASE_URL ||
      'https://dev.azure.com/org'
    ).replace(/\/+$/, '');
    const project = env.ADO_PROJECT || env.ISSUE_TRACKER__PROJECT_IDENTIFIER || 'DefaultProject';
    return createDefaultUnconfiguredProfile('ado-default', 'ado', baseUrl, project);
  }

  const baseUrl = (
    env.JIRA_URL ||
    env.ATLASSIAN_URL ||
    env.ISSUE_TRACKER__BASE_URL ||
    'https://your-domain.atlassian.net'
  ).replace(/\/+$/, '');
  const project = env.JIRA_PROJECT || env.ISSUE_TRACKER__PROJECT_IDENTIFIER || 'PROJ';
  return createDefaultUnconfiguredProfile('jira-default', 'jira', baseUrl, project);
}

/**
 * Given a fetched ticket's metadata (`issueType`, `labels`, `areaPath`, `project`),
 * finds the best matching connected board in `.tktcraft/config.json` so that `tkt get` and
 * `tkt update` always resolve the exact board column and board deep-link URL!
 */
export function resolveMatchingBoardProfileForTicket(
  ticket: {
    project?: string;
    issueType?: string;
    labels?: string[];
    areaPath?: string;
  },
  fallbackProfile: TktProfile,
  workspaceDir: string = process.cwd()
): TktProfile {
  const config = loadWorkspaceConfig(workspaceDir);
  if (!config || Object.keys(config.profiles).length <= 1) {
    return fallbackProfile;
  }
  return resolveActiveProfile({
    issueTypeHint: ticket.issueType,
    labelsHint: ticket.labels,
    areaPathHint: ticket.areaPath,
    workspaceDir,
  });
}

export function createDefaultUnconfiguredProfile(
  name: string,
  provider: ProviderType,
  baseUrl: string,
  project: string
): TktProfile {
  const boardUrl =
    provider === 'jira'
      ? `${baseUrl}/jira/software/c/projects/${project}/boards`
      : `${baseUrl}/${encodeURIComponent(project)}/_boards`;
  const selectedTemplate =
    provider === 'jira'
      ? `${baseUrl}/browse/{key}`
      : `${baseUrl}/${encodeURIComponent(project)}/_workitems/edit/{key}`;

  return {
    name,
    provider,
    baseUrl,
    project,
    board: {
      alias: name,
      id: 'unconfigured',
      name: `${project} Default Board (Run 'tkt setup' to select board)`,
      project,
      boardType: provider === 'jira' ? 'kanban' : 'Stories',
      archetype: 'kanban',
      boardUrl,
      selectedTicketBoardUrlTemplate: selectedTemplate,
      columns:
        provider === 'jira'
          ? [
              { columnName: 'To Do', statuses: ['To Do', 'Open', 'Backlog'], category: 'todo' },
              { columnName: 'In Progress', statuses: ['In Progress'], category: 'in_progress' },
              { columnName: 'Done', statuses: ['Done', 'Closed'], category: 'done' },
            ]
          : [
              { columnName: 'New', statuses: ['New', 'To Do'], category: 'todo' },
              { columnName: 'Active', statuses: ['Active', 'Doing', 'In Progress'], category: 'in_progress' },
              { columnName: 'Closed', statuses: ['Closed', 'Done', 'Resolved'], category: 'done' },
            ],
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
}

/**
 * Resolves credentials from `.env` and `process.env` for a given profile or provider.
 */
export function resolveCredentials(
  profileOrProvider: TktProfile | ProviderType,
  workspaceDir: string = process.cwd(),
  overrides: { baseUrl?: string; user?: string; token?: string; authType?: string } = {}
): ResolvedCredentials {
  const env = { ...loadDotEnv(workspaceDir), ...process.env };
  const isProfile = typeof profileOrProvider === 'object';
  const provider: ProviderType = isProfile ? profileOrProvider.provider : profileOrProvider;

  if (provider === 'jira') {
    const urlVar = isProfile ? profileOrProvider.envVars?.url : undefined;
    const userVar = isProfile ? profileOrProvider.envVars?.user : undefined;
    const tokenVar = isProfile ? profileOrProvider.envVars?.token : undefined;

    const baseUrl = (
      overrides.baseUrl ||
      (urlVar ? env[urlVar] : undefined) ||
      (isProfile ? profileOrProvider.baseUrl : undefined) ||
      env.JIRA_URL ||
      env.ATLASSIAN_URL ||
      env.ISSUE_TRACKER__BASE_URL ||
      ''
    ).replace(/\/+$/, '');

    const user =
      overrides.user ||
      (userVar ? env[userVar] : undefined) ||
      env.JIRA_USER ||
      env.ATLASSIAN_USER_EMAIL ||
      env.ISSUE_TRACKER__USER ||
      '';

    const token =
      overrides.token ||
      (tokenVar ? env[tokenVar] : undefined) ||
      env.JIRA_TOKEN ||
      env.JIRA_PAT ||
      env.ATLASSIAN_API_TOKEN ||
      env.ISSUE_TRACKER__TOKEN ||
      '';

    const rawAuthType =
      overrides.authType ||
      (isProfile ? profileOrProvider.authType : undefined) ||
      env.JIRA_AUTH_TYPE ||
      'cloud';

    const authType = rawAuthType === 'datacenter' || rawAuthType === 'bearer' ? 'datacenter' : 'cloud';

    if (!baseUrl) {
      throw new Error(
        `Missing Jira URL. Set JIRA_URL in .tktcraft/.env or run 'tkt setup' (see SETUP.md).`
      );
    }
    if (!token) {
      throw new Error(
        `Missing Jira API token. Set JIRA_TOKEN in .tktcraft/.env or run 'tkt setup' (see SETUP.md).`
      );
    }
    if (authType === 'cloud' && !user) {
      throw new Error(
        `Missing Jira user email for Jira Cloud Basic Auth. Set JIRA_USER in .tktcraft/.env or run 'tkt setup'.`
      );
    }

    const authHeader =
      authType === 'datacenter'
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

    return {
      provider: 'jira',
      baseUrl,
      user,
      token,
      authHeader,
      authType,
    };
  }

  // Azure DevOps ('ado')
  const urlVar = isProfile ? profileOrProvider.envVars?.url : undefined;
  const userVar = isProfile ? profileOrProvider.envVars?.user : undefined;
  const tokenVar = isProfile ? profileOrProvider.envVars?.token : undefined;

  const baseUrl = (
    overrides.baseUrl ||
    (urlVar ? env[urlVar] : undefined) ||
    (isProfile ? profileOrProvider.baseUrl : undefined) ||
    env.ADO_ORG_URL ||
    env.AZURE_DEVOPS_ORG_URL ||
    env.ISSUE_TRACKER__BASE_URL ||
    ''
  ).replace(/\/+$/, '');

  const user =
    overrides.user ||
    (userVar ? env[userVar] : undefined) ||
    env.ADO_USER ||
    env.ISSUE_TRACKER__USER ||
    '';

  const token =
    overrides.token ||
    (tokenVar ? env[tokenVar] : undefined) ||
    env.ADO_TOKEN ||
    env.AZURE_TOKEN ||
    env.AZURE_DEVOPS_EXT_PAT ||
    env.ISSUE_TRACKER__TOKEN ||
    '';

  if (!baseUrl) {
    throw new Error(
      `Missing Azure DevOps Organization URL. Set ADO_ORG_URL (e.g. https://dev.azure.com/your-org) in .tktcraft/.env or run 'tkt setup'.`
    );
  }
  if (!token) {
    throw new Error(
      `Missing Azure DevOps PAT token. Set ADO_TOKEN in .tktcraft/.env or run 'tkt setup' (see SETUP.md).`
    );
  }

  const rawAuthType =
    overrides.authType ||
    (isProfile ? profileOrProvider.authType : undefined) ||
    env.ADO_AUTH_TYPE ||
    'pat';

  const authType = rawAuthType === 'bearer' ? 'bearer' : 'pat';
  const authHeader =
    authType === 'bearer'
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`:${token}`).toString('base64')}`;

  return {
    provider: 'ado',
    baseUrl,
    user,
    token,
    authHeader,
    authType,
  };
}

/**
 * Maps a status name to its corresponding visual column name on the connected board,
 * or maps a user-supplied column name to the underlying workflow status name.
 */
export function resolveBoardColumnForStatus(
  board: ConnectedBoardConfig,
  statusName: string
): string | undefined {
  if (!statusName) return undefined;
  const lower = statusName.trim().toLowerCase();
  for (const col of board.columns) {
    if (col.statuses.some((s) => s.toLowerCase() === lower)) {
      return col.columnName;
    }
  }
  for (const col of board.columns) {
    if (col.columnName.toLowerCase() === lower) {
      return col.columnName;
    }
  }
  return undefined;
}

/**
 * Given a user or AI input that might be either a visual Board Column name
 * (e.g. "💡 Idea Captured", "Tech Assessment", "Doing") OR a workflow status name,
 * returns the candidate workflow status names that belong to that column.
 */
export function resolveTargetStatusesFromColumnOrStatus(
  board: ConnectedBoardConfig,
  columnOrStatus: string
): string[] {
  const cleaned = columnOrStatus.trim();
  const lower = cleaned.toLowerCase();

  const stripEmoji = (s: string) =>
    s.replace(/^[^\w\s]+\s*/, '').trim().toLowerCase();

  for (const col of board.columns) {
    if (
      col.columnName.toLowerCase() === lower ||
      stripEmoji(col.columnName) === stripEmoji(cleaned)
    ) {
      return col.statuses.length > 0 ? col.statuses : [cleaned];
    }
  }
  return [cleaned];
}

export function buildBoardViewUrl(
  profile: TktProfile,
  ticketKey: string
): string {
  const tpl = profile.board.selectedTicketBoardUrlTemplate;
  if (tpl && tpl.includes('{key}')) {
    return tpl.replace(/\{key\}/g, ticketKey);
  }
  if (profile.provider === 'jira') {
    if (profile.board.id && profile.board.id !== 'unconfigured') {
      return `${profile.baseUrl}/jira/software/c/projects/${profile.project}/boards/${profile.board.id}?selectedIssue=${ticketKey}`;
    }
    return `${profile.baseUrl}/browse/${ticketKey}`;
  }
  return `${profile.baseUrl}/${encodeURIComponent(profile.project)}/_workitems/edit/${ticketKey}`;
}

/**
 * Analyzes a sample of tickets from a board to build Tier 2 Empirical Conventions
 * (issue type distribution, real label vocabulary, title pattern, description headings).
 */
export function analyzeEmpiricalBoardConventions(
  tickets: Array<{
    issueType: string;
    summary: string;
    labels: string[];
    description?: string;
    parentKey?: string;
    assignee?: string;
  }>
): import('../types.ts').BoardEmpiricalConventions {
  const issueTypeCounts: Record<string, number> = {};
  const labelCounts = new Map<string, number>();
  const headingCounts = new Map<string, number>();
  const assignees = new Set<string>();
  let bracketPrefixCount = 0;
  let conventionalPrefixCount = 0;
  let parentLinkedCount = 0;

  for (const t of tickets) {
    if (t.issueType) {
      issueTypeCounts[t.issueType] = (issueTypeCounts[t.issueType] ?? 0) + 1;
    }
    for (const lbl of t.labels ?? []) {
      labelCounts.set(lbl, (labelCounts.get(lbl) ?? 0) + 1);
    }
    if (/^\[[^\]]+\]\s+\S+/.test(t.summary.trim())) {
      bracketPrefixCount += 1;
    } else if (/^[a-z]+(\([^)]+\))?:\s+\S+/i.test(t.summary.trim())) {
      conventionalPrefixCount += 1;
    }
    if (t.parentKey) {
      parentLinkedCount += 1;
    }
    if (t.assignee && t.assignee !== 'Unassigned') {
      assignees.add(t.assignee);
    }
    if (t.description) {
      const withoutCodeBlocks = t.description.replace(/```[\s\S]*?```/g, '');
      const hMatches = withoutCodeBlocks.matchAll(/^#{1,3}\s+([A-Za-z][^\n#]{1,45})$/gm);
      for (const m of hMatches) {
        const h = m[1].trim();
        if (h.length <= 45 && !h.endsWith('.')) {
          headingCounts.set(h, (headingCounts.get(h) ?? 0) + 1);
        }
      }
    }
  }

  const total = tickets.length;
  let detectedTitlePattern = 'Sentence case (`<Verb> <Outcome>`)';
  if (total > 0 && bracketPrefixCount / total >= 0.35) {
    detectedTitlePattern = 'Bracketed domain/module prefix (`[<Domain/Module>] <Verb> <Outcome>`)';
  } else if (total > 0 && conventionalPrefixCount / total >= 0.35) {
    detectedTitlePattern = 'Conventional prefix (`<type>: <summary>`)';
  }

  const activeLabelsVocabulary = Array.from(labelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([label, count]) => ({ label, count }));

  const commonDescriptionHeadings = Array.from(headingCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([h]) => h);

  const nonTrivialSummaries = tickets
    .map((t) => t.summary.trim())
    .filter((s) => s.length >= 12);

  return {
    sampledTicketCount: total,
    issueTypeCounts,
    activeLabelsVocabulary,
    detectedTitlePattern,
    sampleSummaries: (nonTrivialSummaries.length > 0
      ? nonTrivialSummaries
      : tickets.map((t) => t.summary)
    ).slice(0, 5),
    commonDescriptionHeadings,
    parentLinkPercentage:
      total > 0 ? Math.round((parentLinkedCount / total) * 100) : undefined,
    activeAssignees: Array.from(assignees).slice(0, 12),
  };
}

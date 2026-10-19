import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
export function loadDotEnv(workspaceDir: string = process.cwd()): Record<string, string> {
  const envPath = join(workspaceDir, '.env');
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

export function upsertDotEnvValues(
  updates: Record<string, string>,
  workspaceDir: string = process.cwd()
): string {
  const envPath = join(workspaceDir, '.env');
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

  writeFileSync(envPath, newLines.join('\n').trimEnd() + '\n', 'utf-8');
  return envPath;
}

export function getConfigPath(workspaceDir: string = process.cwd()): string {
  return join(workspaceDir, '.tkt', 'config.json');
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
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return cfgPath;
}

export function upsertProfile(
  profile: TktProfile,
  setDefault: boolean = true,
  workspaceDir: string = process.cwd()
): TktWorkspaceConfig {
  const existing = loadWorkspaceConfig(workspaceDir) ?? {
    version: 1 as const,
    defaultProfile: profile.name,
    profiles: {},
  };
  existing.profiles[profile.name] = profile;
  if (setDefault || !existing.defaultProfile) {
    existing.defaultProfile = profile.name;
  }
  saveWorkspaceConfig(existing, workspaceDir);
  generateBoardContextMarkdown(profile, workspaceDir);
  return existing;
}

/**
 * Writes a human & AI-readable board reference guide in `.tkt/boards/<profile>.md`
 * whenever a user connects to a board during `tkt setup`.
 */
export function generateBoardContextMarkdown(
  profile: TktProfile,
  workspaceDir: string = process.cwd()
): string {
  const boardsDir = join(workspaceDir, '.tkt', 'boards');
  mkdirSync(boardsDir, { recursive: true });
  const mdPath = join(boardsDir, `${profile.name}.md`);
  const b = profile.board;

  const colRows = b.columns
    .map(
      (c) =>
        `| **${c.columnName}** | ${c.statuses.map((s) => `\`${s}\``).join(', ')} | \`${c.category ?? 'in_progress'}\` |`
    )
    .join('\n');

  const typeSections = b.issueTypes
    .map((it) => {
      const reqFields = it.fields.filter((f) => f.required);
      const optFields = it.fields.filter((f) => !f.required);
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
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const placementLines: string[] = [];
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
      `- **Active Sprint**: \`${b.placement.activeSprintName}\` (ID: \`${b.placement.activeSprintId}\`)`
    );
  }

  const md = `# Connected Board Schema: ${b.name} (\`${profile.name}\`)

> Auto-generated by \`tkt setup\` on ${b.syncedAt}.
> Used by AI Agents and CLI Pre/Post-Hooks to guarantee structured outputs and board placement.

## 1. Connection & Board Identity
- **Profile**: \`${profile.name}\`
- **Provider**: \`${profile.provider === 'jira' ? 'Jira' : 'Azure DevOps'}\`
- **Base URL**: \`${profile.baseUrl}\`
- **Project**: \`${profile.project}\`
- **Board Name**: **${b.name}** (ID: \`${b.id}\`)
- **Board Type / Archetype**: \`${b.boardType}\` / \`${b.archetype}\`
- **Board View URL**: ${b.boardUrl}
- **Selected Ticket URL Pattern**: \`${b.selectedTicketBoardUrlTemplate}\`

## 2. Board Placement Rules (How Tickets Appear on This Board)
${placementLines.length ? placementLines.join('\n') : '- Standard project placement (`project = ' + profile.project + '`).'}

## 3. Board Column <-> Workflow Status Mapping
| Board Column | Underlying Status / State(s) | Category |
| :--- | :--- | :--- |
${colRows || '| *(Default)* | `To Do`, `In Progress`, `Done` | `in_progress` |'}

## 4. Issue / Work Item Types on This Board
${typeSections || '*(Standard issue types)*'}
`;

  writeFileSync(mdPath, md, 'utf-8');
  return mdPath;
}

/**
 * Resolves the active profile based on:
 * 1. Explicit `--profile <name>`
 * 2. Explicit `--provider <jira|ado>`
 * 3. Auto-detection from ticket key format (e.g. `AIEAE-123` -> Jira, `12345` -> ADO)
 * 4. `TKT_DEFAULT_PROFILE` or `config.defaultProfile`
 */
export function resolveActiveProfile(
  options: {
    profileName?: string;
    provider?: ProviderType;
    ticketKeyHint?: string;
    workspaceDir?: string;
  } = {}
): TktProfile {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const config = loadWorkspaceConfig(workspaceDir);
  const env = { ...loadDotEnv(workspaceDir), ...process.env };

  if (config && Object.keys(config.profiles).length > 0) {
    if (options.profileName) {
      const p = config.profiles[options.profileName];
      if (!p) {
        const available = Object.keys(config.profiles).join(', ');
        throw new Error(
          `Profile '${options.profileName}' not found in .tkt/config.json. Available profiles: ${available}`
        );
      }
      return p;
    }

    if (options.provider) {
      const match = Object.values(config.profiles).find(
        (p) => p.provider === options.provider
      );
      if (match) return match;
    }

    if (options.ticketKeyHint) {
      const isJiraStyle = /^[A-Z][A-Z0-9_]+-\d+$/i.test(options.ticketKeyHint.trim());
      const isAdoStyle = /^\d+$/.test(options.ticketKeyHint.trim());
      if (isJiraStyle) {
        const prefix = options.ticketKeyHint.split('-')[0].toUpperCase();
        const exactProj = Object.values(config.profiles).find(
          (p) => p.provider === 'jira' && p.project.toUpperCase() === prefix
        );
        if (exactProj) return exactProj;
        const anyJira = Object.values(config.profiles).find((p) => p.provider === 'jira');
        if (anyJira) return anyJira;
      } else if (isAdoStyle) {
        const anyAdo = Object.values(config.profiles).find((p) => p.provider === 'ado');
        if (anyAdo) return anyAdo;
      }
    }

    const envDefault = env.TKT_DEFAULT_PROFILE;
    if (envDefault && config.profiles[envDefault]) {
      return config.profiles[envDefault];
    }

    if (config.defaultProfile && config.profiles[config.defaultProfile]) {
      return config.profiles[config.defaultProfile];
    }

    return Object.values(config.profiles)[0];
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
    return createDefaultUnconfiguredProfile('ado-env', 'ado', baseUrl, project);
  }

  const baseUrl = (
    env.JIRA_URL ||
    env.ATLASSIAN_URL ||
    env.ISSUE_TRACKER__BASE_URL ||
    'https://your-domain.atlassian.net'
  ).replace(/\/+$/, '');
  const project = env.JIRA_PROJECT || env.ISSUE_TRACKER__PROJECT_IDENTIFIER || 'PROJ';
  return createDefaultUnconfiguredProfile('jira-env', 'jira', baseUrl, project);
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
      id: 'unconfigured',
      name: `${project} Default Board (Run 'tkt setup' to select board)`,
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
        `Missing Jira URL. Set JIRA_URL in .env or run 'tkt setup' (see SETUP.md).`
      );
    }
    if (!token) {
      throw new Error(
        `Missing Jira API token. Set JIRA_TOKEN in .env or run 'tkt setup' (see SETUP.md).`
      );
    }
    if (authType === 'cloud' && !user) {
      throw new Error(
        `Missing Jira user email for Jira Cloud Basic Auth. Set JIRA_USER in .env or run 'tkt setup'.`
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
      `Missing Azure DevOps Organization URL. Set ADO_ORG_URL (e.g. https://dev.azure.com/your-org) in .env or run 'tkt setup'.`
    );
  }
  if (!token) {
    throw new Error(
      `Missing Azure DevOps PAT token. Set ADO_TOKEN in .env or run 'tkt setup' (see SETUP.md).`
    );
  }

  const rawAuthType =
    overrides.authType ||
    (isProfile ? profileOrProvider.authType : undefined) ||
    env.ADO_AUTH_TYPE ||
    'pat';

  const authType = rawAuthType === 'bearer' ? 'bearer' : 'pat';
  // Azure DevOps PAT uses Basic auth with empty username: `Basic base64(":PAT")`
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

  // Strip leading emojis when comparing column names (e.g. "💡 Idea Captured" matches "idea captured")
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

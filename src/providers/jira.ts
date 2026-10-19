import {
  analyzeEmpiricalBoardConventions,
  buildBoardViewUrl,
  resolveBoardColumnForStatus,
  resolveMatchingBoardProfileForTicket,
  resolveTargetStatusesFromColumnOrStatus,
  type ResolvedCredentials,
} from '../config/manager.ts';
import { adfToMarkdown, markdownToAdf, type AdfNode } from '../formatters/markdown-adf.ts';
import type {
  BoardArchetype,
  BoardColumnMapping,
  BoardEmpiricalConventions,
  BoardFieldDefinition,
  BoardIssueTypeSchema,
  ConnectedBoardConfig,
  CreateTicketInput,
  SearchTicketsInput,
  TicketComment,
  TktProfile,
  TransitionOption,
  UnifiedTicket,
  UpdateTicketInput,
} from '../types.ts';
import type {
  AuthenticatedUserInfo,
  BoardSummary,
  DuplicateCandidate,
  ProjectSummary,
  TrackerProvider,
} from './base.ts';

/**
 * Extracts required labels from a Jira board's JQL filter query.
 */
export function extractRequiredLabelsFromJql(jql: string): string[] {
  if (!jql) return [];
  const labels = new Set<string>();

  const eqRegex = /\blabels\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = eqRegex.exec(jql)) !== null) {
    const val = match[1] || match[2] || match[3];
    if (val && val.toUpperCase() !== 'EMPTY') {
      labels.add(val);
    }
  }

  const inRegex = /\blabels\s+in\s*\(([^)]+)\)/gi;
  while ((match = inRegex.exec(jql)) !== null) {
    const rawItems = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (rawItems.length === 1) {
      labels.add(rawItems[0]);
    }
  }

  return Array.from(labels);
}

/**
 * Extracts explicitly routed issue types from a Jira board's JQL filter query.
 * e.g. `project = AIEAE AND issuetype in (Initiative, Epic) ORDER BY Rank ASC`
 *   -> ["Initiative", "Epic"]
 */
export function extractRoutedIssueTypesFromJql(jql: string): string[] {
  if (!jql) return [];
  const types = new Set<string>();

  const eqRegex = /\b(?:issuetype|type)\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = eqRegex.exec(jql)) !== null) {
    const val = match[1] || match[2] || match[3];
    if (val) types.add(val);
  }

  const inRegex = /\b(?:issuetype|type)\s+in\s*\(([^)]+)\)/gi;
  while ((match = inRegex.exec(jql)) !== null) {
    const items = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    for (const item of items) {
      if (!item.endsWith('()')) {
        types.add(item);
      }
    }
  }

  return Array.from(types);
}

export function inferBoardArchetype(
  boardName: string,
  boardType: string,
  jql: string = ''
): BoardArchetype {
  const combined = `${boardName} ${boardType} ${jql}`.toLowerCase();
  if (combined.includes('discovery') || combined.includes('intake') || combined.includes('idea')) {
    return 'discovery';
  }
  if (combined.includes('roadmap') || combined.includes('epic') || combined.includes('portfolio')) {
    return 'roadmap';
  }
  if (combined.includes('bug') || combined.includes('triage') || combined.includes('support')) {
    return 'bug-triage';
  }
  if (boardType.toLowerCase() === 'scrum' || combined.includes('sprint')) {
    return 'scrum';
  }
  return 'kanban';
}

export class JiraProvider implements TrackerProvider {
  readonly providerType = 'jira' as const;
  private readonly creds: ResolvedCredentials;
  private readonly profile: TktProfile;
  private readonly apiVersion: '2' | '3';

  constructor(creds: ResolvedCredentials, profile: TktProfile) {
    this.creds = creds;
    this.profile = profile;
    this.apiVersion = creds.authType === 'datacenter' ? '2' : '3';
  }

  private async request<T = any>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: unknown
  ): Promise<T> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.creds.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.creds.authHeader,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Force-Accept-Language': 'true',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `Jira API HTTP ${resp.status} on ${method} ${endpoint}:\n${text}`
      );
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async testConnection(): Promise<AuthenticatedUserInfo> {
    const data = await this.request(`/rest/api/${this.apiVersion}/myself`);
    return {
      id: data.accountId || data.key || data.name || 'unknown',
      displayName: data.displayName || data.name || 'Unknown User',
      email: data.emailAddress || this.creds.user,
      provider: 'jira',
      baseUrl: this.creds.baseUrl,
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const data = await this.request<any[]>(`/rest/api/${this.apiVersion}/project`);
    return (Array.isArray(data) ? data : []).map((p) => ({
      id: String(p.id),
      key: String(p.key),
      name: String(p.name),
      projectType: p.projectTypeKey,
    }));
  }

  async listBoards(projectKeyOrName: string): Promise<BoardSummary[]> {
    const projectKey = projectKeyOrName.toUpperCase();
    try {
      const data = await this.request<{ values?: any[] }>(
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`
      );
      return (data.values ?? []).map((b) => ({
        id: String(b.id),
        name: String(b.name),
        type: String(b.type || 'kanban'),
        projectKey,
      }));
    } catch {
      return [
        {
          id: 'default',
          name: `${projectKey} Main Board`,
          type: 'kanban',
          projectKey,
        },
      ];
    }
  }

  async introspectBoard(
    projectKeyOrName: string,
    board: BoardSummary
  ): Promise<ConnectedBoardConfig> {
    const projectKey = projectKeyOrName.toUpperCase();
    const columns: BoardColumnMapping[] = [];
    let filterId: string | undefined;
    let filterQuery: string | undefined;
    let requiredLabels: string[] = [];
    let routedIssueTypes: string[] = [];
    let activeSprintId: number | undefined;
    let activeSprintName: string | undefined;
    let activeSprintGoal: string | undefined;
    let conventions: BoardEmpiricalConventions | undefined;

    if (board.id !== 'default' && board.id !== 'unconfigured') {
      try {
        const cfg = await this.request<any>(
          `/rest/agile/1.0/board/${board.id}/configuration`
        );
        filterId = cfg?.filter?.id ? String(cfg.filter.id) : undefined;

        const statusMap = new Map<string, { name: string; category?: string }>();
        try {
          const allStatuses = await this.request<any[]>(
            `/rest/api/${this.apiVersion}/status`
          );
          for (const st of allStatuses ?? []) {
            statusMap.set(String(st.id), {
              name: st.name,
              category: st.statusCategory?.key,
            });
          }
        } catch {
          // ignore if status catalog fails
        }

        const rawCols = cfg?.columnConfig?.columns ?? [];
        for (const col of rawCols) {
          const statuses: string[] = [];
          const statusIds: string[] = [];
          let category: 'todo' | 'in_progress' | 'done' = 'in_progress';

          for (const stObj of col.statuses ?? []) {
            const stId = String(stObj.id);
            statusIds.push(stId);
            const resolved = statusMap.get(stId);
            if (resolved?.name) {
              statuses.push(resolved.name);
              if (resolved.category === 'new') category = 'todo';
              else if (resolved.category === 'done') category = 'done';
            }
          }
          if (statuses.length === 0 && col.name) {
            statuses.push(col.name);
          }
          columns.push({
            columnName: String(col.name),
            statuses,
            statusIds,
            category,
            wipMin: typeof col.min === 'number' ? col.min : undefined,
            wipMax: typeof col.max === 'number' ? col.max : undefined,
          });
        }
      } catch {
        // Fallback columns if board configuration endpoint is unavailable
      }

      if (filterId) {
        try {
          const filterData = await this.request<any>(
            `/rest/api/${this.apiVersion}/filter/${filterId}`
          );
          if (filterData?.jql) {
            filterQuery = String(filterData.jql);
            requiredLabels = extractRequiredLabelsFromJql(filterQuery);
            routedIssueTypes = extractRoutedIssueTypesFromJql(filterQuery);
          }
        } catch {
          // ignore filter fetch error
        }
      }

      if (board.type.toLowerCase() === 'scrum') {
        try {
          const sprints = await this.request<any>(
            `/rest/agile/1.0/board/${board.id}/sprint?state=active`
          );
          const active = sprints?.values?.[0];
          if (active) {
            activeSprintId = Number(active.id);
            activeSprintName = String(active.name);
            activeSprintGoal = active.goal ? String(active.goal) : undefined;
          }
        } catch {
          // ignore sprint lookup failure
        }
      }

      // Tier 2: Sample recent tickets on this specific board to learn empirical conventions
      try {
        const boardIssues = await this.request<{ issues?: any[] }>(
          `/rest/agile/1.0/board/${board.id}/issue?maxResults=25&fields=summary,issuetype,labels,description,parent,assignee`
        );
        const rawList = boardIssues?.issues ?? [];
        if (rawList.length > 0) {
          const mappedSample = rawList.map((iss: any) => {
            const f = iss.fields ?? {};
            return {
              issueType: String(f.issuetype?.name || 'Task'),
              summary: String(f.summary || ''),
              labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
              description:
                typeof f.description === 'string'
                  ? f.description
                  : adfToMarkdown(f.description as AdfNode),
              parentKey: f.parent?.key ? String(f.parent.key) : undefined,
              assignee: f.assignee?.displayName || undefined,
            };
          });
          conventions = analyzeEmpiricalBoardConventions(mappedSample);
          if (routedIssueTypes.length === 0 && conventions) {
            routedIssueTypes = Object.keys(conventions.issueTypeCounts);
          }
        }
      } catch {
        // Empirical ticket sampling is best-effort
      }
    }

    if (columns.length === 0) {
      columns.push(
        { columnName: 'To Do', statuses: ['To Do', 'Open', 'Backlog'], category: 'todo' },
        { columnName: 'In Progress', statuses: ['In Progress'], category: 'in_progress' },
        { columnName: 'Done', statuses: ['Done', 'Closed'], category: 'done' }
      );
    }

    // Tier 1: Introspect project issue types & fields
    const issueTypes: BoardIssueTypeSchema[] = [];
    try {
      const projData = await this.request<any>(
        `/rest/api/${this.apiVersion}/project/${encodeURIComponent(projectKey)}`
      );
      for (const it of projData.issueTypes ?? []) {
        const fields: BoardFieldDefinition[] = [
          { key: 'summary', name: 'Summary', required: true, type: 'string' },
        ];
        try {
          const meta = await this.request<any>(
            `/rest/api/${this.apiVersion}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${it.id}`
          );
          const metaFields = meta?.fields || meta?.values || [];
          for (const mf of Array.isArray(metaFields) ? metaFields : Object.values(metaFields)) {
            const fieldKey = (mf as any).fieldId || (mf as any).key;
            if (!fieldKey || ['project', 'issuetype', 'summary', 'reporter'].includes(fieldKey)) {
              continue;
            }
            if ((mf as any).required || String(fieldKey).startsWith('customfield_')) {
              fields.push({
                key: String(fieldKey),
                name: String((mf as any).name || fieldKey),
                required: Boolean((mf as any).required),
                type: String((mf as any).schema?.type || 'string'),
                allowedValues: Array.isArray((mf as any).allowedValues)
                  ? (mf as any).allowedValues.slice(0, 20).map((av: any) => ({
                      id: av.id ? String(av.id) : undefined,
                      name: String(av.value || av.name || av.id),
                    }))
                  : undefined,
              });
            }
          }
        } catch {
          // createmeta optional
        }

        issueTypes.push({
          id: String(it.id),
          name: String(it.name),
          subtask: Boolean(it.subtask),
          description: it.description ? String(it.description) : undefined,
          fields,
        });
      }
    } catch {
      // ignore if project details fail
    }

    const boardUrl =
      board.id !== 'default' && board.id !== 'unconfigured'
        ? `${this.creds.baseUrl}/jira/software/c/projects/${projectKey}/boards/${board.id}`
        : `${this.creds.baseUrl}/jira/software/c/projects/${projectKey}/boards`;

    const selectedTicketBoardUrlTemplate =
      board.id !== 'default' && board.id !== 'unconfigured'
        ? `${this.creds.baseUrl}/jira/software/c/projects/${projectKey}/boards/${board.id}?selectedIssue={key}`
        : `${this.creds.baseUrl}/browse/{key}`;

    return {
      id: board.id,
      name: board.name,
      project: projectKey,
      boardType: board.type,
      archetype: inferBoardArchetype(board.name, board.type, filterQuery),
      boardUrl,
      selectedTicketBoardUrlTemplate,
      columns,
      issueTypes,
      placement: {
        requiredLabels,
        routedIssueTypes: routedIssueTypes.length > 0 ? routedIssueTypes : undefined,
        filterId,
        filterQuery,
        activeSprintId,
        activeSprintName,
        activeSprintGoal,
      },
      conventions,
      syncedAt: new Date().toISOString(),
    };
  }

  private mapRawIssueToUnified(issue: any): UnifiedTicket {
    const f = issue.fields ?? {};
    const key = String(issue.key);
    const status = String(f.status?.name ?? 'Unknown');
    const issueType = String(f.issuetype?.name || 'Task');
    const labels = Array.isArray(f.labels) ? f.labels.map(String) : [];
    const project = String(f.project?.key || this.profile.project);

    // Match against all connected Jira boards in the workspace so cross-board tickets
    // resolve to the right board's column and deep-link URL!
    const matchedProfile = resolveMatchingBoardProfileForTicket(
      { project, issueType, labels },
      this.profile
    );

    const boardColumn = resolveBoardColumnForStatus(matchedProfile.board, status);
    const desc =
      typeof f.description === 'string'
        ? f.description
        : adfToMarkdown(f.description as AdfNode);

    const commentsRaw = f.comment?.comments ?? [];
    const comments: TicketComment[] = commentsRaw.map((c: any) => ({
      id: String(c.id),
      author: String(c.author?.displayName || c.author?.name || 'Unknown'),
      created: String(c.created || ''),
      body:
        typeof c.body === 'string'
          ? c.body
          : adfToMarkdown(c.body as AdfNode),
    }));

    return {
      key,
      provider: 'jira',
      project,
      issueType,
      summary: String(f.summary || ''),
      status,
      boardColumn,
      priority: f.priority?.name ? String(f.priority.name) : undefined,
      assignee: f.assignee?.displayName || f.assignee?.emailAddress || undefined,
      reporter: f.reporter?.displayName || f.reporter?.emailAddress || undefined,
      parentKey: f.parent?.key ? String(f.parent.key) : undefined,
      labels,
      description: desc,
      created: f.created ? String(f.created) : undefined,
      updated: f.updated ? String(f.updated) : undefined,
      directUrl: `${this.creds.baseUrl}/browse/${key}`,
      boardViewUrl: buildBoardViewUrl(matchedProfile, key),
      boardName: matchedProfile.board.name,
      boardId: matchedProfile.board.id,
      boardProfile: matchedProfile.name,
      comments,
    };
  }

  async getTicket(key: string): Promise<UnifiedTicket> {
    const normalizedKey = key.trim().toUpperCase();
    const data = await this.request(
      `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(normalizedKey)}`
    );
    return this.mapRawIssueToUnified(data);
  }

  async searchTickets(input: SearchTicketsInput): Promise<UnifiedTicket[]> {
    let jql = input.query?.trim() || '';
    if (!jql) {
      const clauses: string[] = [`project = "${this.profile.project}"`];
      if (input.boardOnly && this.profile.board.placement.requiredLabels?.length) {
        const lbls = this.profile.board.placement.requiredLabels
          .map((l) => `"${l}"`)
          .join(', ');
        clauses.push(`labels IN (${lbls})`);
      }
      if (input.boardOnly && this.profile.board.placement.routedIssueTypes?.length && !input.issueType) {
        const rTypes = this.profile.board.placement.routedIssueTypes
          .map((t) => `"${t}"`)
          .join(', ');
        clauses.push(`issuetype IN (${rTypes})`);
      }
      if (input.issueType) {
        clauses.push(`issuetype = "${input.issueType}"`);
      }
      if (input.statusOrColumn) {
        const targetStatuses = resolveTargetStatusesFromColumnOrStatus(
          this.profile.board,
          input.statusOrColumn
        );
        const stList = targetStatuses.map((s) => `"${s}"`).join(', ');
        clauses.push(`status IN (${stList})`);
      }
      if (input.assignee) {
        clauses.push(
          input.assignee.toLowerCase() === 'me'
            ? `assignee = currentUser()`
            : `assignee = "${input.assignee}"`
        );
      }
      jql = `${clauses.join(' AND ')} ORDER BY created DESC`;
    }

    const fields = [
      'summary',
      'status',
      'issuetype',
      'assignee',
      'reporter',
      'priority',
      'labels',
      'parent',
      'project',
      'created',
      'updated',
    ];

    let data: any;
    if (this.apiVersion === '3') {
      data = await this.request(`/rest/api/3/search/jql`, 'POST', {
        jql,
        maxResults: input.maxResults ?? 20,
        fields,
      });
    } else {
      data = await this.request(`/rest/api/2/search`, 'POST', {
        jql,
        maxResults: input.maxResults ?? 20,
        fields,
      });
    }

    return (data.issues ?? []).map((iss: any) => this.mapRawIssueToUnified(iss));
  }

  async findDuplicates(
    projectKeyOrName: string,
    _issueType: string,
    summary: string
  ): Promise<DuplicateCandidate[]> {
    const stopWords = new Set([
      'implement',
      'create',
      'update',
      'with',
      'from',
      'that',
      'this',
      'when',
      'should',
      'into',
      'support',
      'feature',
      'ticket',
    ]);
    const words = summary
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4 && !stopWords.has(w.toLowerCase()))
      .slice(0, 4);

    if (words.length === 0) return [];
    const keywordClause = words.join(' ');
    const escaped = keywordClause.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const jql = `project = "${projectKeyOrName}" AND text ~ "${escaped}" ORDER BY created DESC`;

    try {
      const results = await this.searchTickets({ query: jql, maxResults: 3 });
      return results.map((r) => ({
        key: r.key,
        summary: r.summary,
        status: r.status,
        directUrl: r.directUrl,
      }));
    } catch {
      return [];
    }
  }

  async getTransitions(key: string): Promise<TransitionOption[]> {
    const normalizedKey = key.trim().toUpperCase();
    const data = await this.request<{ transitions?: any[] }>(
      `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(normalizedKey)}/transitions`
    );
    return (data.transitions ?? []).map((t) => {
      const toStatus = String(t.to?.name || t.name || '');
      return {
        id: String(t.id),
        name: String(t.name),
        toStatus,
        mappedBoardColumn: resolveBoardColumnForStatus(this.profile.board, toStatus),
      };
    });
  }

  async createTicket(input: CreateTicketInput): Promise<UnifiedTicket> {
    const projectKey = (input.project || this.profile.project).toUpperCase();
    let fullMarkdown = input.description ?? '';
    if (input.acceptanceCriteria) {
      fullMarkdown += `\n\n## Acceptance Criteria\n${input.acceptanceCriteria}`;
    }
    if (input.reproSteps) {
      fullMarkdown += `\n\n## Repro Steps\n${input.reproSteps}`;
    }

    const labels = new Set<string>(input.labels ?? []);
    if (
      this.profile.governance.autoApplyBoardPlacement &&
      this.profile.board.placement.requiredLabels?.length
    ) {
      for (const reqLabel of this.profile.board.placement.requiredLabels) {
        labels.add(reqLabel);
      }
    }

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary: input.summary.trim(),
      issuetype: { name: input.issueType.trim() },
    };

    if (input.parentKey) {
      fields.parent = { key: input.parentKey.trim().toUpperCase() };
    }

    if (fullMarkdown.trim()) {
      fields.description =
        this.apiVersion === '3' ? markdownToAdf(fullMarkdown) : fullMarkdown;
    }

    if (labels.size > 0) {
      fields.labels = Array.from(labels);
    }

    if (input.priority) {
      fields.priority = { name: input.priority };
    }

    if (input.assignee) {
      try {
        const users = await this.request<any[]>(
          `/rest/api/${this.apiVersion}/user/search?query=${encodeURIComponent(input.assignee)}`
        );
        if (users && users.length > 0) {
          fields.assignee = users[0].accountId
            ? { accountId: users[0].accountId }
            : { name: users[0].name };
        }
      } catch {
        // leave unassigned if user lookup fails
      }
    }

    if (input.customFields) {
      const aliases = this.profile.board.customFieldAliases ?? {};
      const valMaps = this.profile.board.customFieldValueMaps ?? {};
      for (const [rawKey, rawVal] of Object.entries(input.customFields)) {
        const actualFieldKey = aliases[rawKey.toLowerCase()] || rawKey;
        const valueMap = valMaps[rawKey.toLowerCase()];
        const mappedId = valueMap?.[rawVal.toLowerCase()];
        fields[actualFieldKey] = mappedId ? { id: mappedId } : rawVal;
      }
    }

    const created = await this.request<{ key: string }>(
      `/rest/api/${this.apiVersion}/issue`,
      'POST',
      { fields }
    );
    const newKey = created.key;

    if (input.columnOrStatus) {
      try {
        await this.transitionTicketToColumnOrStatus(newKey, input.columnOrStatus);
      } catch {
        // non-fatal if initial status already matches
      }
    }

    return this.getTicket(newKey);
  }

  private async transitionTicketToColumnOrStatus(
    key: string,
    columnOrStatus: string
  ): Promise<string> {
    const candidateStatuses = resolveTargetStatusesFromColumnOrStatus(
      this.profile.board,
      columnOrStatus
    ).map((s) => s.toLowerCase());

    const transitions = await this.getTransitions(key);
    const matched = transitions.find(
      (t) =>
        candidateStatuses.includes(t.toStatus.toLowerCase()) ||
        candidateStatuses.includes(t.name.toLowerCase()) ||
        (t.mappedBoardColumn &&
          t.mappedBoardColumn.toLowerCase() === columnOrStatus.trim().toLowerCase())
    );

    if (!matched) {
      const avail = transitions
        .map((t) => `'${t.name}' -> ${t.toStatus} [Column: ${t.mappedBoardColumn ?? 'N/A'}]`)
        .join(', ');
      throw new Error(
        `No transition matching column/status '${columnOrStatus}' found for ${key}. Available: ${avail}`
      );
    }

    await this.request(
      `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}/transitions`,
      'POST',
      { transition: { id: matched.id } }
    );
    return matched.toStatus;
  }

  async updateTicket(input: UpdateTicketInput): Promise<UnifiedTicket> {
    const key = input.key.trim().toUpperCase();
    const fields: Record<string, unknown> = {};

    if (input.summary) {
      fields.summary = input.summary.trim();
    }
    if (input.description !== undefined) {
      fields.description =
        this.apiVersion === '3'
          ? markdownToAdf(input.description)
          : input.description;
    }
    if (input.labels) {
      fields.labels = input.labels;
    }
    if (input.priority) {
      fields.priority = { name: input.priority };
    }
    if (input.parentKey) {
      fields.parent = { key: input.parentKey.trim().toUpperCase() };
    }
    if (input.assignee) {
      const users = await this.request<any[]>(
        `/rest/api/${this.apiVersion}/user/search?query=${encodeURIComponent(input.assignee)}`
      );
      if (users && users.length > 0) {
        fields.assignee = users[0].accountId
          ? { accountId: users[0].accountId }
          : { name: users[0].name };
      }
    }
    if (input.customFields) {
      const aliases = this.profile.board.customFieldAliases ?? {};
      const valMaps = this.profile.board.customFieldValueMaps ?? {};
      for (const [rawKey, rawVal] of Object.entries(input.customFields)) {
        const actualFieldKey = aliases[rawKey.toLowerCase()] || rawKey;
        const valueMap = valMaps[rawKey.toLowerCase()];
        const mappedId = valueMap?.[rawVal.toLowerCase()];
        fields[actualFieldKey] = mappedId ? { id: mappedId } : rawVal;
      }
    }

    if (Object.keys(fields).length > 0) {
      await this.request(
        `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}`,
        'PUT',
        { fields }
      );
    }

    if (input.comment) {
      const bodyPayload =
        this.apiVersion === '3' ? markdownToAdf(input.comment) : input.comment;
      await this.request(
        `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}/comment`,
        'POST',
        { body: bodyPayload }
      );
    }

    if (input.columnOrStatus) {
      await this.transitionTicketToColumnOrStatus(key, input.columnOrStatus);
    }

    return this.getTicket(key);
  }
}

import {
  analyzeEmpiricalBoardConventions,
  buildBoardViewUrl,
  resolveBoardColumnForStatus,
  resolveMatchingBoardProfileForTicket,
  resolveTargetStatusesFromColumnOrStatus,
  type ResolvedCredentials,
} from '../config/manager.ts';
import {
  adoHtmlToText,
  markdownToAdoHtml,
  splitMarkdownForAdoBoard,
} from '../formatters/markdown-ado.ts';
import type {
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
import { inferBoardArchetype } from './jira.ts';

export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

export function buildWiqlTagsClause(tags: string[]): string {
  const cleaned = tags.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) {
    return `[System.Tags] CONTAINS '${cleaned[0].replace(/'/g, "''")}'`;
  }
  const parts = cleaned.map((t) => `[System.Tags] CONTAINS '${t.replace(/'/g, "''")}'`);
  return `(${parts.join(' OR ')})`;
}

export class AdoProvider implements TrackerProvider {
  readonly providerType = 'ado' as const;
  private readonly creds: ResolvedCredentials;
  private readonly profile: TktProfile;

  constructor(creds: ResolvedCredentials, profile: TktProfile) {
    this.creds = creds;
    this.profile = profile;
  }

  private async request<T = any>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
    body?: unknown,
    contentType: string = 'application/json'
  ): Promise<T> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.creds.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.creds.authHeader,
    };
    if (body !== undefined) {
      headers['Content-Type'] = contentType;
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `Azure DevOps API HTTP ${resp.status} on ${method} ${endpoint}:\n${text}`
      );
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async testConnection(): Promise<AuthenticatedUserInfo> {
    const data = await this.request<any>(
      `/_apis/connectionData?api-version=7.1-preview.1`
    );
    const user = data.authenticatedUser || {};
    return {
      id: String(user.id || 'unknown'),
      displayName: String(
        user.providerDisplayName || user.customDisplayName || 'Authenticated User'
      ),
      email:
        user.properties?.Account?.$value ||
        this.creds.user ||
        undefined,
      provider: 'ado',
      baseUrl: this.creds.baseUrl,
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const data = await this.request<{ value?: any[] }>(
      `/_apis/projects?api-version=7.1`
    );
    return (data.value ?? []).map((p) => ({
      id: String(p.id),
      key: String(p.name),
      name: String(p.name),
      projectType: p.visibility,
    }));
  }

  async listBoards(projectKeyOrName: string): Promise<BoardSummary[]> {
    const proj = encodeURIComponent(projectKeyOrName);
    const boards: BoardSummary[] = [];

    try {
      const teamsRes = await this.request<{ value?: any[] }>(
        `/_apis/projects/${proj}/teams?api-version=7.1`
      );
      const teams = teamsRes.value ?? [];

      for (const team of teams.slice(0, 15)) {
        const teamEnc = encodeURIComponent(team.id || team.name);
        try {
          const bRes = await this.request<{ value?: any[] }>(
            `/${proj}/${teamEnc}/_apis/work/boards?api-version=7.1`
          );
          for (const b of bRes.value ?? []) {
            boards.push({
              id: String(b.id || b.name),
              name: `${team.name} — ${b.name}`,
              type: String(b.name || 'Kanban'),
              projectKey: projectKeyOrName,
              teamName: String(team.name),
              teamId: String(team.id),
            });
          }
        } catch {
          // ignore team without boards
        }
      }
    } catch {
      // fallback if teams endpoint fails
    }

    if (boards.length === 0) {
      boards.push({
        id: 'Stories',
        name: `${projectKeyOrName} — Boards`,
        type: 'Kanban',
        projectKey: projectKeyOrName,
        teamName: `${projectKeyOrName} Team`,
      });
    }
    return boards;
  }

  async introspectBoard(
    projectKeyOrName: string,
    board: BoardSummary
  ): Promise<ConnectedBoardConfig> {
    const projEnc = encodeURIComponent(projectKeyOrName);
    const teamRef = board.teamId || board.teamName || `${projectKeyOrName} Team`;
    const teamEnc = encodeURIComponent(teamRef);

    const columns: BoardColumnMapping[] = [];
    let defaultAreaPath = projectKeyOrName;
    let defaultIterationPath = projectKeyOrName;
    let activeSprintName: string | undefined;
    const routedIssueTypesSet = new Set<string>();
    let conventions: BoardEmpiricalConventions | undefined;

    // 1. Introspect Board Columns <-> Underlying States, WIP Limits & Column Definition of Done!
    try {
      const boardDetail = await this.request<any>(
        `/${projEnc}/${teamEnc}/_apis/work/boards/${encodeURIComponent(board.id)}?api-version=7.1`
      );
      for (const col of boardDetail.columns ?? []) {
        const stateMappings = col.stateMappings ?? {};
        for (const witKey of Object.keys(stateMappings)) {
          routedIssueTypesSet.add(witKey);
        }
        const statuses = Array.from(
          new Set<string>(Object.values(stateMappings).map(String))
        );
        if (statuses.length === 0 && col.name) {
          statuses.push(String(col.name));
        }
        const colType = String(col.columnType || '').toLowerCase();
        const category: 'todo' | 'in_progress' | 'done' =
          colType === 'incoming'
            ? 'todo'
            : colType === 'outgoing'
              ? 'done'
              : 'in_progress';
        columns.push({
          columnName: String(col.name),
          statuses,
          category,
          wipMax: typeof col.itemLimit === 'number' && col.itemLimit > 0 ? col.itemLimit : undefined,
          definitionOfDone: col.description ? String(col.description).trim() : undefined,
        });
      }
    } catch {
      // fallback columns
    }

    if (columns.length === 0) {
      columns.push(
        { columnName: 'New / To Do', statuses: ['New', 'To Do'], category: 'todo' },
        { columnName: 'Active / Doing', statuses: ['Active', 'Doing', 'In Progress', 'Committed'], category: 'in_progress' },
        { columnName: 'Resolved', statuses: ['Resolved', 'Ready for Code Review'], category: 'in_progress' },
        { columnName: 'Closed / Done', statuses: ['Closed', 'Done'], category: 'done' }
      );
    }

    // 2. Introspect Team Settings (Default Area Path & Current Iteration)
    try {
      const teamFieldValues = await this.request<any>(
        `/${projEnc}/${teamEnc}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`
      );
      if (teamFieldValues?.defaultValue) {
        defaultAreaPath = String(teamFieldValues.defaultValue);
      }
    } catch {
      // keep project default
    }

    try {
      const currentIter = await this.request<any>(
        `/${projEnc}/${teamEnc}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`
      );
      const iter = currentIter?.value?.[0];
      if (iter?.path) {
        defaultIterationPath = String(iter.path);
        activeSprintName = String(iter.name || iter.path);
      }
    } catch {
      // keep project default
    }

    // 3. Introspect Work Item Types & Dedicated Fields
    const issueTypes: BoardIssueTypeSchema[] = [];
    try {
      const witRes = await this.request<{ value?: any[] }>(
        `/${projEnc}/_apis/wit/workitemtypes?api-version=7.1`
      );
      for (const wit of witRes.value ?? []) {
        if (wit.isDisabled) continue;
        const witName = String(wit.name);
        if (/test|shared|code review|feedback/i.test(witName)) continue;

        const fieldRefs: any[] = wit.fields || wit.fieldInstances || [];
        const fields: BoardFieldDefinition[] = [
          { key: 'System.Title', name: 'Title', required: true, type: 'string' },
        ];
        let acceptanceCriteriaField: string | undefined;
        let reproStepsField: string | undefined;
        let systemInfoField: string | undefined;

        for (const f of fieldRefs) {
          const refName = String(f.referenceName || '');
          const name = String(f.name || refName);
          if (refName === 'Microsoft.VSTS.Common.AcceptanceCriteria') {
            acceptanceCriteriaField = refName;
          } else if (refName === 'Microsoft.VSTS.TCM.ReproSteps') {
            reproStepsField = refName;
          } else if (refName === 'Microsoft.VSTS.TCM.SystemInfo') {
            systemInfoField = refName;
          }
          if (
            f.alwaysRequired &&
            ![
              'System.Title',
              'System.State',
              'System.AreaPath',
              'System.IterationPath',
              'System.TeamProject',
            ].includes(refName)
          ) {
            fields.push({
              key: refName,
              name,
              required: true,
              type: 'string',
              helpText: f.helpText ? String(f.helpText) : undefined,
            });
          }
        }

        const states = (wit.states ?? []).map((s: any) => String(s.name));
        issueTypes.push({
          id: witName,
          name: witName,
          subtask: /task/i.test(witName),
          description: wit.description ? String(wit.description) : undefined,
          statuses: states,
          fields,
          acceptanceCriteriaField,
          reproStepsField,
          systemInfoField,
        });
      }
    } catch {
      // fallback work item types
    }

    // 4. Tier 2: Empirical Ticket Mining on this board's AreaPath
    try {
      const sampleTickets = await this.searchTickets({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${projectKeyOrName.replace(/'/g, "''")}' AND [System.AreaPath] UNDER '${defaultAreaPath.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`,
        maxResults: 25,
      });
      if (sampleTickets.length > 0) {
        conventions = analyzeEmpiricalBoardConventions(sampleTickets);
      }
    } catch {
      // best-effort empirical mining
    }

    const teamSegment = board.teamName ? encodeURIComponent(board.teamName) : projEnc;
    const boardTypeSegment = encodeURIComponent(board.type || 'Stories');
    const boardUrl = `${this.creds.baseUrl}/${projEnc}/_boards/board/t/${teamSegment}/${boardTypeSegment}`;
    const selectedTicketBoardUrlTemplate = `${boardUrl}?workitem={key}`;

    return {
      id: board.id,
      name: board.name,
      project: projectKeyOrName,
      boardType: board.type,
      archetype: inferBoardArchetype(board.name, board.type),
      boardUrl,
      selectedTicketBoardUrlTemplate,
      columns,
      issueTypes,
      placement: {
        routedIssueTypes:
          routedIssueTypesSet.size > 0
            ? Array.from(routedIssueTypesSet)
            : undefined,
        teamName: board.teamName,
        teamId: board.teamId,
        defaultAreaPath,
        defaultIterationPath,
        activeSprintName,
      },
      conventions,
      syncedAt: new Date().toISOString(),
    };
  }

  private mapWorkItemToUnified(wi: any, comments?: TicketComment[]): UnifiedTicket {
    const f = wi.fields ?? {};
    const key = String(wi.id);
    const status = String(f['System.State'] || 'New');
    const issueType = String(f['System.WorkItemType'] || 'User Story');
    const areaPath = f['System.AreaPath'] ? String(f['System.AreaPath']) : undefined;
    const project = String(f['System.TeamProject'] || this.profile.project);

    const rawTags = String(f['System.Tags'] || '');
    const labels = rawTags
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean);

    // Match against all connected ADO boards in the workspace so cross-board work items
    // resolve to the right Team Board's column and deep-link URL!
    const matchedProfile = resolveMatchingBoardProfileForTicket(
      { project, issueType, labels, areaPath },
      this.profile
    );

    const boardColumn =
      String(f['System.BoardColumn'] || '') ||
      resolveBoardColumnForStatus(matchedProfile.board, status);

    const assigneeObj = f['System.AssignedTo'];
    const assignee =
      typeof assigneeObj === 'string'
        ? assigneeObj
        : assigneeObj?.displayName || assigneeObj?.uniqueName || undefined;

    const reporterObj = f['System.CreatedBy'];
    const reporter =
      typeof reporterObj === 'string'
        ? reporterObj
        : reporterObj?.displayName || reporterObj?.uniqueName || undefined;

    let parentKey: string | undefined = f['System.Parent']
      ? String(f['System.Parent'])
      : undefined;
    if (!parentKey && Array.isArray(wi.relations)) {
      const parentRel = wi.relations.find(
        (r: any) => r.rel === 'System.LinkTypes.Hierarchy-Reverse'
      );
      if (parentRel?.url) {
        const m = String(parentRel.url).match(/\/workItems\/(\d+)$/i);
        if (m) parentKey = m[1];
      }
    }

    const projEnc = encodeURIComponent(project);

    return {
      key,
      provider: 'ado',
      project,
      issueType,
      summary: String(f['System.Title'] || ''),
      status,
      boardColumn: boardColumn || undefined,
      priority:
        f['Microsoft.VSTS.Common.Priority'] !== undefined
          ? String(f['Microsoft.VSTS.Common.Priority'])
          : undefined,
      assignee,
      reporter,
      parentKey,
      labels,
      description: adoHtmlToText(f['System.Description']),
      acceptanceCriteria: adoHtmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']) || undefined,
      reproSteps: adoHtmlToText(f['Microsoft.VSTS.TCM.ReproSteps']) || undefined,
      areaPath,
      iterationPath: f['System.IterationPath'] ? String(f['System.IterationPath']) : undefined,
      storyPoints:
        typeof f['Microsoft.VSTS.Scheduling.StoryPoints'] === 'number'
          ? f['Microsoft.VSTS.Scheduling.StoryPoints']
          : typeof f['Microsoft.VSTS.Scheduling.Effort'] === 'number'
            ? f['Microsoft.VSTS.Scheduling.Effort']
            : undefined,
      created: f['System.CreatedDate'] ? String(f['System.CreatedDate']) : undefined,
      updated: f['System.ChangedDate'] ? String(f['System.ChangedDate']) : undefined,
      directUrl: `${this.creds.baseUrl}/${projEnc}/_workitems/edit/${key}`,
      boardViewUrl: buildBoardViewUrl(matchedProfile, key),
      boardName: matchedProfile.board.name,
      boardId: matchedProfile.board.id,
      boardProfile: matchedProfile.name,
      comments,
    };
  }

  async getTicket(key: string): Promise<UnifiedTicket> {
    const id = key.trim().replace(/^#/, '');
    const projEnc = encodeURIComponent(this.profile.project);
    const wi = await this.request<any>(
      `/${projEnc}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=relations&api-version=7.1`
    );

    let comments: TicketComment[] = [];
    try {
      const cRes = await this.request<any>(
        `/${projEnc}/_apis/wit/workItems/${encodeURIComponent(id)}/comments?api-version=7.1-preview.4`
      );
      comments = (cRes.comments ?? []).map((c: any) => ({
        id: String(c.id),
        author: String(c.createdBy?.displayName || 'Unknown'),
        created: String(c.createdDate || ''),
        body: adoHtmlToText(c.text),
      }));
    } catch {
      // comments optional
    }

    return this.mapWorkItemToUnified(wi, comments);
  }

  async searchTickets(input: SearchTicketsInput): Promise<UnifiedTicket[]> {
    const projEnc = encodeURIComponent(this.profile.project);
    let wiql = input.query?.trim() || '';

    if (!wiql || !/^select\s+/i.test(wiql)) {
      const clauses: string[] = [
        `[System.TeamProject] = '${this.profile.project.replace(/'/g, "''")}'`,
      ];
      if (input.boardOnly && this.profile.board.placement.defaultAreaPath) {
        clauses.push(
          `[System.AreaPath] UNDER '${this.profile.board.placement.defaultAreaPath.replace(/'/g, "''")}'`
        );
      }
      if (input.boardOnly && this.profile.board.placement.requiredLabels?.length) {
        const tagClause = buildWiqlTagsClause(
          this.profile.board.placement.requiredLabels
        );
        if (tagClause) clauses.push(tagClause);
      }
      if (input.issueType) {
        clauses.push(
          `[System.WorkItemType] = '${input.issueType.replace(/'/g, "''")}'`
        );
      }
      if (input.statusOrColumn) {
        const targetStates = resolveTargetStatusesFromColumnOrStatus(
          this.profile.board,
          input.statusOrColumn
        );
        const stList = targetStates.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
        clauses.push(`[System.State] IN (${stList})`);
      }
      if (input.assignee) {
        clauses.push(
          input.assignee.toLowerCase() === 'me'
            ? `[System.AssignedTo] = @Me`
            : `[System.AssignedTo] CONTAINS '${input.assignee.replace(/'/g, "''")}'`
        );
      }
      if (wiql) {
        clauses.push(`[System.Title] CONTAINS '${wiql.replace(/'/g, "''")}'`);
      }
      wiql = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
    }

    const maxResults = input.maxResults ?? 20;
    const wiqlRes = await this.request<{ workItems?: Array<{ id: number }> }>(
      `/${projEnc}/_apis/wit/wiql?$top=${maxResults}&api-version=7.1`,
      'POST',
      { query: wiql }
    );

    const ids = (wiqlRes.workItems ?? []).slice(0, maxResults).map((w) => w.id);
    if (ids.length === 0) return [];

    const batchRes = await this.request<{ value?: any[] }>(
      `/${projEnc}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&api-version=7.1`
    );

    return (batchRes.value ?? []).map((wi) => this.mapWorkItemToUnified(wi));
  }

  async findDuplicates(
    projectKeyOrName: string,
    _issueType: string,
    summary: string
  ): Promise<DuplicateCandidate[]> {
    const words = summary
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4)
      .slice(0, 3);

    if (words.length === 0) return [];
    const wordClauses = words
      .map((w) => `[System.Title] CONTAINS '${w.replace(/'/g, "''")}'`)
      .join(' AND ');
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${projectKeyOrName.replace(/'/g, "''")}' AND (${wordClauses}) ORDER BY [System.ChangedDate] DESC`;

    try {
      const matches = await this.searchTickets({ query: wiql, maxResults: 3 });
      return matches.map((m) => ({
        key: m.key,
        summary: m.summary,
        status: m.status,
        directUrl: m.directUrl,
      }));
    } catch {
      return [];
    }
  }

  async getTransitions(key: string): Promise<TransitionOption[]> {
    const ticket = await this.getTicket(key);
    const witSchema = this.profile.board.issueTypes.find(
      (it) => it.name.toLowerCase() === ticket.issueType.toLowerCase()
    );

    const states = new Set<string>(witSchema?.statuses ?? []);
    for (const col of this.profile.board.columns) {
      for (const st of col.statuses) {
        states.add(st);
      }
    }

    return Array.from(states).map((st, idx) => ({
      id: String(idx + 1),
      name: `Move to ${st}`,
      toStatus: st,
      mappedBoardColumn: resolveBoardColumnForStatus(this.profile.board, st),
    }));
  }

  async createTicket(input: CreateTicketInput): Promise<UnifiedTicket> {
    const project = input.project || this.profile.project;
    const projEnc = encodeURIComponent(project);

    let targetType = input.issueType.trim();
    const availableTypes = this.profile.board.issueTypes;
    const exactMatch = availableTypes.find(
      (it) => it.name.toLowerCase() === targetType.toLowerCase()
    );
    if (exactMatch) {
      targetType = exactMatch.name;
    } else if (['story', 'user story', 'userstory'].includes(targetType.toLowerCase())) {
      const pbi = availableTypes.find((it) => /^(pbi|product backlog item)$/i.test(it.name));
      if (pbi) targetType = pbi.name;
    } else if (['pbi', 'product backlog item'].includes(targetType.toLowerCase())) {
      const story = availableTypes.find((it) => /^(user story|story)$/i.test(it.name));
      if (story) targetType = story.name;
    }

    const witEnc = encodeURIComponent(`$${targetType}`);

    const split = splitMarkdownForAdoBoard({
      issueType: input.issueType,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      reproSteps: input.reproSteps,
    });

    const patch: JsonPatchOperation[] = [
      {
        op: 'add',
        path: '/fields/System.Title',
        value: input.summary.trim(),
      },
    ];

    if (split.descriptionHtml) {
      patch.push({
        op: 'add',
        path: '/fields/System.Description',
        value: split.descriptionHtml,
      });
    }

    if (split.acceptanceCriteriaHtml) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
        value: split.acceptanceCriteriaHtml,
      });
    }

    if (split.reproStepsHtml) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.TCM.ReproSteps',
        value: split.reproStepsHtml,
      });
    }

    if (split.systemInfoHtml) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.TCM.SystemInfo',
        value: split.systemInfoHtml,
      });
    }

    const areaPath =
      input.areaPath ||
      (this.profile.governance.autoApplyBoardPlacement
        ? this.profile.board.placement.defaultAreaPath
        : undefined);
    if (areaPath) {
      patch.push({
        op: 'add',
        path: '/fields/System.AreaPath',
        value: areaPath,
      });
    }

    const iterationPath =
      input.iterationPath ||
      (this.profile.governance.autoApplyBoardPlacement
        ? this.profile.board.placement.defaultIterationPath
        : undefined);
    if (iterationPath) {
      patch.push({
        op: 'add',
        path: '/fields/System.IterationPath',
        value: iterationPath,
      });
    }

    const tags = new Set<string>(input.labels ?? []);
    if (
      this.profile.governance.autoApplyBoardPlacement &&
      this.profile.board.placement.requiredLabels?.length
    ) {
      for (const t of this.profile.board.placement.requiredLabels) {
        tags.add(t);
      }
    }
    if (tags.size > 0) {
      patch.push({
        op: 'add',
        path: '/fields/System.Tags',
        value: Array.from(tags).join('; '),
      });
    }

    if (input.assignee) {
      patch.push({
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: input.assignee,
      });
    }

    if (input.priority) {
      const pMap: Record<string, number> = {
        highest: 1,
        critical: 1,
        showstopper: 1,
        '1': 1,
        high: 2,
        major: 2,
        '2': 2,
        medium: 2,
        normal: 2,
        low: 3,
        minor: 3,
        '3': 3,
        lowest: 4,
        cosmetics: 4,
        '4': 4,
      };
      const pNum = pMap[input.priority.toLowerCase()] ?? 2;
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.Priority',
        value: pNum,
      });
    }

    if (input.storyPoints !== undefined) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
        value: input.storyPoints,
      });
    }

    if (input.columnOrStatus) {
      const targetStates = resolveTargetStatusesFromColumnOrStatus(
        this.profile.board,
        input.columnOrStatus
      );
      patch.push({
        op: 'add',
        path: '/fields/System.State',
        value: targetStates[0],
      });
    }

    if (input.parentKey) {
      const parentId = input.parentKey.trim().replace(/^#/, '');
      patch.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.creds.baseUrl}/${projEnc}/_apis/wit/workItems/${parentId}`,
          attributes: { comment: 'Linked parent via tktcraft CLI' },
        },
      });
    }

    if (input.customFields) {
      const aliases = this.profile.board.customFieldAliases ?? {};
      for (const [k, v] of Object.entries(input.customFields)) {
        const fieldRef = aliases[k.toLowerCase()] || k;
        patch.push({
          op: 'add',
          path: `/fields/${fieldRef}`,
          value: v,
        });
      }
    }

    const created = await this.request<any>(
      `/${projEnc}/_apis/wit/workitems/${witEnc}?api-version=7.1`,
      'POST',
      patch,
      'application/json-patch+json'
    );

    return this.mapWorkItemToUnified(created);
  }

  async updateTicket(input: UpdateTicketInput): Promise<UnifiedTicket> {
    const id = input.key.trim().replace(/^#/, '');
    const projEnc = encodeURIComponent(this.profile.project);
    const patch: JsonPatchOperation[] = [];

    if (input.summary) {
      patch.push({
        op: 'add',
        path: '/fields/System.Title',
        value: input.summary.trim(),
      });
    }

    if (input.description !== undefined) {
      patch.push({
        op: 'add',
        path: '/fields/System.Description',
        value: markdownToAdoHtml(input.description),
      });
    }

    if (input.acceptanceCriteria !== undefined) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
        value: markdownToAdoHtml(input.acceptanceCriteria),
      });
    }

    if (input.reproSteps !== undefined) {
      patch.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.TCM.ReproSteps',
        value: markdownToAdoHtml(input.reproSteps),
      });
    }

    if (input.columnOrStatus) {
      const targetStates = resolveTargetStatusesFromColumnOrStatus(
        this.profile.board,
        input.columnOrStatus
      );
      patch.push({
        op: 'add',
        path: '/fields/System.State',
        value: targetStates[0],
      });
    }

    if (input.labels) {
      patch.push({
        op: 'add',
        path: '/fields/System.Tags',
        value: input.labels.join('; '),
      });
    }

    if (input.assignee) {
      patch.push({
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: input.assignee,
      });
    }

    if (input.areaPath) {
      patch.push({
        op: 'add',
        path: '/fields/System.AreaPath',
        value: input.areaPath,
      });
    }

    if (input.iterationPath) {
      patch.push({
        op: 'add',
        path: '/fields/System.IterationPath',
        value: input.iterationPath,
      });
    }

    if (input.comment) {
      patch.push({
        op: 'add',
        path: '/fields/System.History',
        value: markdownToAdoHtml(input.comment),
      });
    }

    if (input.customFields) {
      const aliases = this.profile.board.customFieldAliases ?? {};
      for (const [k, v] of Object.entries(input.customFields)) {
        const fieldRef = aliases[k.toLowerCase()] || k;
        patch.push({
          op: 'add',
          path: `/fields/${fieldRef}`,
          value: v,
        });
      }
    }

    if (patch.length > 0) {
      await this.request(
        `/${projEnc}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1`,
        'PATCH',
        patch,
        'application/json-patch+json'
      );
    }

    return this.getTicket(id);
  }
}

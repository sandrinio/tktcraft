import type {
  ConnectedBoardConfig,
  OutputFormat,
  StructuredBoardOutput,
  TktProfile,
  TransitionOption,
  UnifiedTicket,
} from '../types.ts';

export function formatStructuredEnvelope<T>(
  profile: TktProfile,
  action: string,
  data: T,
  options: {
    links?: { directUrl: string; boardViewUrl: string };
    preHooksPassed?: string[];
    postHooksExecuted?: string[];
    warnings?: string[];
  } = {}
): StructuredBoardOutput<T> {
  return {
    ok: true,
    action,
    provider: profile.provider,
    profile: profile.name,
    project: profile.project,
    board: {
      id: profile.board.id,
      name: profile.board.name,
      type: profile.board.boardType,
      archetype: profile.board.archetype,
      boardUrl: profile.board.boardUrl,
      columns: profile.board.columns.map((c) => ({
        column: c.columnName,
        statuses: c.statuses,
      })),
    },
    links: options.links,
    hooks:
      options.preHooksPassed || options.postHooksExecuted || options.warnings
        ? {
            preHooksPassed: options.preHooksPassed ?? [],
            postHooksExecuted: options.postHooksExecuted ?? [],
            warnings: options.warnings,
          }
        : undefined,
    data,
  };
}

export function renderTicketOutput(
  ticket: UnifiedTicket,
  profile: TktProfile,
  format: OutputFormat,
  hookMeta?: {
    action?: string;
    preHooksPassed?: string[];
    postHooksExecuted?: string[];
    warnings?: string[];
  }
): string {
  const envelope = formatStructuredEnvelope(
    profile,
    hookMeta?.action ?? 'get',
    ticket,
    {
      links: {
        directUrl: ticket.directUrl,
        boardViewUrl: ticket.boardViewUrl,
      },
      preHooksPassed: hookMeta?.preHooksPassed,
      postHooksExecuted: hookMeta?.postHooksExecuted,
      warnings: hookMeta?.warnings,
    }
  );

  if (format === 'json') {
    return JSON.stringify(envelope, null, 2);
  }

  if (format === 'agent') {
    // Compact, token-efficient structured representation for AI agents
    const compact = {
      key: ticket.key,
      provider: ticket.provider,
      project: ticket.project,
      board: `${profile.board.name} (#${profile.board.id})`,
      boardColumn: ticket.boardColumn ?? ticket.status,
      status: ticket.status,
      type: ticket.issueType,
      priority: ticket.priority ?? 'Default',
      assignee: ticket.assignee ?? 'Unassigned',
      parent: ticket.parentKey ?? null,
      labels: ticket.labels,
      summary: ticket.summary,
      directUrl: ticket.directUrl,
      boardViewUrl: ticket.boardViewUrl,
      description: ticket.description,
      ...(ticket.acceptanceCriteria ? { acceptanceCriteria: ticket.acceptanceCriteria } : {}),
      ...(ticket.reproSteps ? { reproSteps: ticket.reproSteps } : {}),
      ...(ticket.comments?.length ? { recentComments: ticket.comments.slice(-5) } : {}),
    };
    return JSON.stringify(compact, null, 2);
  }

  if (format === 'md') {
    const lines = [
      `### 🎫 [${ticket.key}](${ticket.directUrl}) — ${ticket.summary}`,
      ``,
      `| Field | Value |`,
      `| :--- | :--- |`,
      `| **Provider / Project** | \`${ticket.provider.toUpperCase()}\` / \`${ticket.project}\` |`,
      `| **Connected Board** | [${profile.board.name}](${profile.board.boardUrl}) |`,
      `| **Board Column** | **${ticket.boardColumn ?? ticket.status}** *(Status: \`${ticket.status}\`)* |`,
      `| **Issue Type** | \`${ticket.issueType}\` |`,
      `| **Priority** | \`${ticket.priority ?? 'Default'}\` |`,
      `| **Assignee** | \`${ticket.assignee ?? 'Unassigned'}\` |`,
      ticket.parentKey ? `| **Parent** | \`${ticket.parentKey}\` |` : '',
      ticket.labels.length ? `| **Labels / Tags** | ${ticket.labels.map((l) => `\`${l}\``).join(', ')} |` : '',
      `| **Direct Ticket Link** | ${ticket.directUrl} |`,
      `| **Board View Link** | ${ticket.boardViewUrl} |`,
      ``,
      `#### Description`,
      ticket.description || '*(No description)*',
    ].filter(Boolean);

    if (ticket.acceptanceCriteria) {
      lines.push('', '#### Acceptance Criteria', ticket.acceptanceCriteria);
    }
    if (ticket.reproSteps) {
      lines.push('', '#### Repro Steps', ticket.reproSteps);
    }
    return lines.join('\n');
  }

  // Default: 'human' terminal output
  const hr = '='.repeat(76);
  const dash = '-'.repeat(76);
  const lines = [
    hr,
    `Ticket:       ${ticket.key} — ${ticket.summary}`,
    `Direct Link:  ${ticket.directUrl}`,
    `Board Link:   ${ticket.boardViewUrl}`,
    hr,
    `Provider:     ${ticket.provider === 'jira' ? 'Jira' : 'Azure DevOps'} (Profile: ${profile.name})`,
    `Board:        ${profile.board.name} (ID: ${profile.board.id}, Type: ${profile.board.boardType})`,
    `Board Column: ${ticket.boardColumn ?? '(Unmapped)'}  [Status: ${ticket.status}]`,
    `Type:         ${ticket.issueType}`,
    `Priority:     ${ticket.priority ?? 'None'}`,
    `Assignee:     ${ticket.assignee ?? 'Unassigned'}`,
    `Reporter:     ${ticket.reporter ?? 'Unknown'}`,
    `Parent:       ${ticket.parentKey ?? 'None'}`,
    `Labels/Tags:  ${ticket.labels.length ? ticket.labels.join(', ') : 'None'}`,
  ];
  if (ticket.areaPath) lines.push(`Area Path:    ${ticket.areaPath}`);
  if (ticket.iterationPath) lines.push(`Iteration:    ${ticket.iterationPath}`);
  if (ticket.created) lines.push(`Created:      ${ticket.created}`);
  if (ticket.updated) lines.push(`Updated:      ${ticket.updated}`);

  lines.push(dash, 'Description:', ticket.description || '(No description)');

  if (ticket.acceptanceCriteria) {
    lines.push(dash, 'Acceptance Criteria:', ticket.acceptanceCriteria);
  }
  if (ticket.reproSteps) {
    lines.push(dash, 'Repro Steps:', ticket.reproSteps);
  }

  if (ticket.comments && ticket.comments.length > 0) {
    lines.push(dash, `Comments (${ticket.comments.length}):`);
    for (const c of ticket.comments.slice(-5)) {
      lines.push(`  [${c.created.slice(0, 16)}] ${c.author}:`);
      for (const l of c.body.split('\n')) {
        lines.push(`    ${l}`);
      }
    }
  }
  lines.push(hr);
  return lines.join('\n');
}

export function renderTicketListOutput(
  tickets: UnifiedTicket[],
  profile: TktProfile,
  format: OutputFormat,
  queryLabel: string
): string {
  const envelope = formatStructuredEnvelope(profile, 'search', {
    query: queryLabel,
    count: tickets.length,
    tickets,
  });

  if (format === 'json') {
    return JSON.stringify(envelope, null, 2);
  }

  if (format === 'agent') {
    return JSON.stringify(
      {
        board: `${profile.board.name} (${profile.provider.toUpperCase()})`,
        boardUrl: profile.board.boardUrl,
        count: tickets.length,
        tickets: tickets.map((t) => ({
          key: t.key,
          type: t.issueType,
          boardColumn: t.boardColumn ?? t.status,
          status: t.status,
          priority: t.priority,
          assignee: t.assignee ?? 'Unassigned',
          summary: t.summary,
          directUrl: t.directUrl,
          boardViewUrl: t.boardViewUrl,
        })),
      },
      null,
      2
    );
  }

  if (format === 'md') {
    const header = [
      `### 📋 Board Tickets — [${profile.board.name}](${profile.board.boardUrl}) (${tickets.length} found)`,
      ``,
      `| Key | Type | Board Column (Status) | Assignee | Summary | Board View |`,
      `| :--- | :--- | :--- | :--- | :--- | :--- |`,
    ];
    const rows = tickets.map(
      (t) =>
        `| [${t.key}](${t.directUrl}) | \`${t.issueType}\` | **${t.boardColumn ?? t.status}** (\`${t.status}\`) | ${t.assignee ?? 'Unassigned'} | ${t.summary} | [View on Board](${t.boardViewUrl}) |`
    );
    return [...header, ...rows].join('\n');
  }

  const lines = [
    `Board: ${profile.board.name} [${profile.provider.toUpperCase()} / ${profile.project}]`,
    `Found ${tickets.length} ticket(s) (${queryLabel}):\n`,
    `${'Key'.padEnd(12)} ${'Type'.padEnd(14)} ${'Board Column'.padEnd(22)} ${'Status'.padEnd(16)} ${'Assignee'.padEnd(18)} Summary`,
    '-'.repeat(110),
  ];

  for (const t of tickets) {
    const col = (t.boardColumn ?? t.status).slice(0, 21).padEnd(22);
    const st = t.status.slice(0, 15).padEnd(16);
    const it = t.issueType.slice(0, 13).padEnd(14);
    const asg = (t.assignee ?? 'Unassigned').slice(0, 17).padEnd(18);
    lines.push(`${t.key.padEnd(12)} ${it} ${col} ${st} ${asg} ${t.summary}`);
  }
  return lines.join('\n');
}

export function renderBoardSchemaOutput(
  profile: TktProfile,
  format: OutputFormat
): string {
  const b: ConnectedBoardConfig = profile.board;
  if (format === 'json' || format === 'agent') {
    return JSON.stringify(
      formatStructuredEnvelope(profile, 'board-schema', b),
      null,
      2
    );
  }

  const lines = [
    '='.repeat(76),
    `Connected Board: ${b.name} (ID: ${b.id})`,
    `Provider:        ${profile.provider === 'jira' ? 'Jira' : 'Azure DevOps'} (Profile: ${profile.name})`,
    `Project:         ${profile.project}`,
    `Board Type:      ${b.boardType} (Archetype: ${b.archetype})`,
    `Board URL:       ${b.boardUrl}`,
    `Ticket DeepLink: ${b.selectedTicketBoardUrlTemplate}`,
    '='.repeat(76),
    '\n1. BOARD COLUMNS <-> WORKFLOW STATUSES:',
    `${'Board Column'.padEnd(30)} ${'Category'.padEnd(14)} Underlying Statuses`,
    '-'.repeat(76),
  ];

  for (const col of b.columns) {
    lines.push(
      `${col.columnName.padEnd(30)} ${(col.category ?? 'in_progress').padEnd(14)} ${col.statuses.join(', ')}`
    );
  }

  lines.push('\n2. AUTOMATIC BOARD PLACEMENT RULES:');
  if (b.placement.requiredLabels?.length) {
    lines.push(`  • Auto-Applied Labels/Tags: ${b.placement.requiredLabels.join(', ')}`);
  }
  if (b.placement.filterQuery) {
    lines.push(`  • Board Filter Query:       ${b.placement.filterQuery}`);
  }
  if (b.placement.defaultAreaPath) {
    lines.push(`  • Default Area Path:        ${b.placement.defaultAreaPath}`);
  }
  if (b.placement.defaultIterationPath) {
    lines.push(`  • Default Iteration Path:   ${b.placement.defaultIterationPath}`);
  }
  if (b.placement.activeSprintName) {
    lines.push(
      `  • Active Sprint:            ${b.placement.activeSprintName} (ID: ${b.placement.activeSprintId})`
    );
  }
  if (
    !b.placement.requiredLabels?.length &&
    !b.placement.filterQuery &&
    !b.placement.defaultAreaPath
  ) {
    lines.push(`  • Standard project filter (project = ${profile.project})`);
  }

  lines.push('\n3. ISSUE / WORK ITEM TYPES & REQUIRED FIELDS:');
  if (b.issueTypes.length === 0) {
    lines.push('  (Run `tkt setup` or `tkt discover` with live credentials to sync field schemas)');
  } else {
    for (const it of b.issueTypes) {
      const reqFields = it.fields.filter((f) => f.required).map((f) => `${f.name} (${f.key})`);
      lines.push(
        `  • ${it.name}${it.subtask ? ' [Sub-task]' : ''}: Required=[${reqFields.join(', ') || 'summary'}]`
      );
      if (it.acceptanceCriteriaField) {
        lines.push(`      ↳ Dedicated AC Field: ${it.acceptanceCriteriaField}`);
      }
      if (it.reproStepsField) {
        lines.push(`      ↳ Dedicated Repro Field: ${it.reproStepsField}`);
      }
    }
  }
  lines.push('='.repeat(76));
  return lines.join('\n');
}

export function renderTransitionsOutput(
  key: string,
  transitions: TransitionOption[],
  profile: TktProfile,
  format: OutputFormat
): string {
  if (format === 'json' || format === 'agent') {
    return JSON.stringify(
      formatStructuredEnvelope(profile, 'transitions', {
        key,
        transitions,
      }),
      null,
      2
    );
  }

  const lines = [
    `Available transitions / states for ${key} on board '${profile.board.name}':\n`,
    `${'ID'.padEnd(12)} ${'Transition / Action'.padEnd(26)} ${'Target Status'.padEnd(24)} Board Column`,
    '-'.repeat(85),
  ];
  for (const t of transitions) {
    lines.push(
      `${t.id.padEnd(12)} ${t.name.slice(0, 25).padEnd(26)} ${t.toStatus.slice(0, 23).padEnd(24)} ${t.mappedBoardColumn ?? '(Unmapped)'}`
    );
  }
  return lines.join('\n');
}

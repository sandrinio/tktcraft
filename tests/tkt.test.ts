import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adfToMarkdown, markdownToAdf } from '../src/formatters/markdown-adf.ts';
import {
  adoHtmlToText,
  markdownToAdoHtml,
  splitMarkdownForAdoBoard,
} from '../src/formatters/markdown-ado.ts';
import { extractRequiredLabelsFromJql } from '../src/providers/jira.ts';
import { buildWiqlTagsClause } from '../src/providers/ado.ts';
import {
  buildBoardViewUrl,
  resolveActiveProfile,
  resolveBoardColumnForStatus,
  resolveTargetStatusesFromColumnOrStatus,
  upsertProfile,
} from '../src/config/manager.ts';
import {
  evaluatePostToolUsePayload,
  evaluatePreToolUsePayload,
} from '../src/hooks/agent-harness.ts';
import { runPostHooks } from '../src/hooks/engine.ts';
import type { TktProfile, UnifiedTicket } from '../src/types.ts';

describe('1. Jira ADF Formatter (Markdown <-> ADF v1)', () => {
  it('converts Markdown headings, tables, checklists, code blocks, and inline marks to ADF and back', () => {
    const md = `# Epic Title

Here is **bold**, *italic*, \`inline_code\`, and a [Doc Link](https://example.com).

| Board Column | Jira Status |
| :--- | :--- |
| 💡 Idea Captured | Backlog |
| 💬 Product Discussion | In Progress |

* [ ] Unchecked item
* [x] Completed item

\`\`\`typescript
const x = 42;
\`\`\`
`;

    const adf = markdownToAdf(md);
    assert.equal(adf.type, 'doc');
    assert.equal(adf.version, 1);
    assert.ok(Array.isArray(adf.content));

    const types = adf.content.map((n) => n.type);
    assert.ok(types.includes('heading'));
    assert.ok(types.includes('paragraph'));
    assert.ok(types.includes('table'));
    assert.ok(types.includes('bulletList'));
    assert.ok(types.includes('codeBlock'));

    const roundTrip = adfToMarkdown(adf);
    assert.ok(roundTrip.includes('# Epic Title'));
    assert.ok(roundTrip.includes('**bold**'));
    assert.ok(roundTrip.includes('💡 Idea Captured'));
    assert.ok(roundTrip.includes('☐ Unchecked item'));
    assert.ok(roundTrip.includes('☑ Completed item'));
    assert.ok(roundTrip.includes('const x = 42;'));
  });
});

describe('2. Azure DevOps HTML & Multi-Field Board Splitter', () => {
  it('splits Acceptance Criteria, Repro Steps, and System Info into dedicated ADO board fields', () => {
    const bugMarkdown = `## The Issue
Login button fails on Safari 18 when third-party cookies are blocked.

## Repro Steps
1. Open Safari 18
2. Click Sign In with SSO
3. **Observed:** Blank popup window

## System Info
- Browser: Safari 18.1
- Environment: Staging

## Acceptance Criteria
- [ ] SSO login succeeds on Safari 18
- [ ] Clear error toast if popup is blocked`;

    const split = splitMarkdownForAdoBoard({
      issueType: 'Bug',
      description: bugMarkdown,
    });

    assert.ok(split.descriptionHtml.includes('Login button fails on Safari 18'));
    assert.ok(!split.descriptionHtml.includes('Open Safari 18'));
    assert.ok(split.reproStepsHtml?.includes('<ol>'));
    assert.ok(split.reproStepsHtml?.includes('Open Safari 18'));
    assert.ok(split.systemInfoHtml?.includes('Safari 18.1'));
    assert.ok(split.acceptanceCriteriaHtml?.includes('SSO login succeeds on Safari 18'));

    const plainText = adoHtmlToText(split.acceptanceCriteriaHtml);
    assert.ok(plainText.includes('SSO login succeeds on Safari 18'));
  });

  it(' builds valid WIQL tag clauses for Azure DevOps semicolon-delimited tags', () => {
    assert.equal(
      buildWiqlTagsClause(['EAE-Implementation']),
      "[System.Tags] CONTAINS 'EAE-Implementation'"
    );
    assert.equal(
      buildWiqlTagsClause(['frontend', 'urgent']),
      "([System.Tags] CONTAINS 'frontend' OR [System.Tags] CONTAINS 'urgent')"
    );
  });
});

describe('3. Board Introspection Helpers & Column <-> Status Routing', () => {
  it('extracts required board labels from Jira JQL filters', () => {
    const jql1 =
      'project = AIEAE AND labels = EAE-Implementation ORDER BY Rank ASC';
    assert.deepEqual(extractRequiredLabelsFromJql(jql1), ['EAE-Implementation']);

    const jql2 =
      'project = "AIEAE" AND labels in ("business_req_for_agent") AND status != Closed';
    assert.deepEqual(extractRequiredLabelsFromJql(jql2), [
      'business_req_for_agent',
    ]);
  });

  it('maps board columns (including emoji headers) to underlying workflow statuses and back', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tkt-test-'));
    try {
      const discoveryProfile: TktProfile = {
        name: 'jira-discovery',
        provider: 'jira',
        baseUrl: 'https://exadel.atlassian.net',
        project: 'AIEAE',
        board: {
          id: '4893',
          name: 'EAE Product Discovery & Intake',
          boardType: 'kanban',
          archetype: 'discovery',
          boardUrl:
            'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4893',
          selectedTicketBoardUrlTemplate:
            'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4893?selectedIssue={key}',
          columns: [
            { columnName: '💡 Idea Captured', statuses: ['Backlog'], category: 'todo' },
            { columnName: '💬 Product Discussion', statuses: ['In Progress'], category: 'in_progress' },
            { columnName: '🔬 Tech Assessment', statuses: ['Ready for Code review'], category: 'in_progress' },
            { columnName: '🏁 Converted', statuses: ['Closed'], category: 'done' },
          ],
          issueTypes: [],
          placement: {
            requiredLabels: ['EAE-Discovery'],
          },
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

      upsertProfile(discoveryProfile, true, tmpDir);

      // Status -> Visual Board Column
      assert.equal(
        resolveBoardColumnForStatus(discoveryProfile.board, 'Ready for Code review'),
        '🔬 Tech Assessment'
      );

      // Visual Board Column (with or without emoji!) -> Underlying Status
      assert.deepEqual(
        resolveTargetStatusesFromColumnOrStatus(
          discoveryProfile.board,
          'Tech Assessment'
        ),
        ['Ready for Code review']
      );
      assert.deepEqual(
        resolveTargetStatusesFromColumnOrStatus(
          discoveryProfile.board,
          '💡 Idea Captured'
        ),
        ['Backlog']
      );

      // Deep-link generation
      assert.equal(
        buildBoardViewUrl(discoveryProfile, 'AIEAE-1900'),
        'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4893?selectedIssue=AIEAE-1900'
      );

      // Auto-detect profile from ticket key hint
      const adoProfile: TktProfile = {
        ...discoveryProfile,
        name: 'ado-sprint',
        provider: 'ado',
        baseUrl: 'https://dev.azure.com/myorg',
        project: 'CloudPlatform',
        board: {
          ...discoveryProfile.board,
          id: 'Stories',
          name: 'CloudPlatform — Stories',
          selectedTicketBoardUrlTemplate:
            'https://dev.azure.com/myorg/CloudPlatform/_boards/board/t/Team/Stories?workitem={key}',
        },
      };
      upsertProfile(adoProfile, false, tmpDir);

      const resolvedForJiraKey = resolveActiveProfile({
        ticketKeyHint: 'AIEAE-1871',
        workspaceDir: tmpDir,
      });
      assert.equal(resolvedForJiraKey.name, 'jira-discovery');

      const resolvedForAdoId = resolveActiveProfile({
        ticketKeyHint: '45912',
        workspaceDir: tmpDir,
      });
      assert.equal(resolvedForAdoId.name, 'ado-sprint');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('4. Pre-Hooks & Post-Hooks (AI Harness & CLI Pipeline)', () => {
  it('PreToolUse hook hard-denies any delete/remove command on Jira or Azure DevOps', () => {
    const denyPayload = JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'tkt delete AIEAE-123' },
      },
    });
    const decision = evaluatePreToolUsePayload(denyPayload);
    assert.equal(decision.decision, 'deny');
    assert.ok(decision.reason?.includes('strictly forbidden'));
  });

  it('PreToolUse hook forces confirmation (force_ask) on create/update commands', () => {
    const createPayload = JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine:
            'tkt create --type Story --summary "[Core] Add caching" --yes',
        },
      },
    });
    const decision = evaluatePreToolUsePayload(createPayload);
    assert.equal(decision.decision, 'force_ask');
    assert.ok(decision.reason?.includes('Ticket Creation requested'));
  });

  it('PreToolUse hook allows read-only commands and --dry-run previews', () => {
    const readPayload = JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'tkt search --board-only' },
      },
    });
    assert.equal(evaluatePreToolUsePayload(readPayload).decision, 'allow');

    const dryRunPayload = JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine:
            'tkt create --type Story --summary "Test" --dry-run',
        },
      },
    });
    assert.equal(evaluatePreToolUsePayload(dryRunPayload).decision, 'allow');
  });

  it('Post-Hook writes audit log and extracts Direct + Board View links', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tkt-posthook-'));
    try {
      const profile = resolveActiveProfile({ workspaceDir: tmpDir });
      const sampleTicket: UnifiedTicket = {
        key: 'AIEAE-2048',
        provider: 'jira',
        project: 'AIEAE',
        issueType: 'Story',
        summary: '[Board CLI] Unified Jira and ADO integration',
        status: 'In Progress',
        boardColumn: 'In Progress',
        labels: ['EAE-Implementation'],
        description: 'Sample description',
        directUrl: 'https://exadel.atlassian.net/browse/AIEAE-2048',
        boardViewUrl:
          'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4887?selectedIssue=AIEAE-2048',
      };

      const postRes = runPostHooks(profile, 'create', sampleTicket, tmpDir);
      assert.ok(postRes.executedHooks.includes('board-links-verifier'));
      assert.ok(postRes.executedHooks.includes('audit-log'));

      const auditContent = readFileSync(
        join(tmpDir, '.tkt', 'audit.jsonl'),
        'utf-8'
      );
      const parsed = JSON.parse(auditContent.trim());
      assert.equal(parsed.key, 'AIEAE-2048');
      assert.equal(
        parsed.boardViewUrl,
        'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4887?selectedIssue=AIEAE-2048'
      );

      const harnessPost = evaluatePostToolUsePayload(
        JSON.stringify({
          output: `Ticket Key: AIEAE-2048\nDirect Link: ${sampleTicket.directUrl}\nBoard Link: ${sampleTicket.boardViewUrl}`,
        })
      );
      assert.equal(harnessPost.decision, 'allow');
      assert.ok(harnessPost.postHookMessage?.includes(sampleTicket.directUrl));
      assert.ok(harnessPost.postHookMessage?.includes(sampleTicket.boardViewUrl));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adfToMarkdown, markdownToAdf } from '../src/formatters/markdown-adf.ts';
import {
  adoHtmlToText,
  splitMarkdownForAdoBoard,
} from '../src/formatters/markdown-ado.ts';
import {
  extractRequiredLabelsFromJql,
  extractRoutedIssueTypesFromJql,
} from '../src/providers/jira.ts';
import { buildWiqlTagsClause } from '../src/providers/ado.ts';
import {
  analyzeEmpiricalBoardConventions,
  buildBoardViewUrl,
  generateBoardContextMarkdown,
  loadWorkspaceConfig,
  resolveActiveProfile,
  resolveBoardColumnForStatus,
  resolveMatchingBoardProfileForTicket,
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

  it('builds valid WIQL tag clauses for Azure DevOps semicolon-delimited tags', () => {
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

describe('3. Single-Account Multi-Board Routing (Jira+Jira & ADO+ADO) & Tier 2 Empirical Mining', () => {
  it('extracts required labels and routed issue types from Jira JQL filters', () => {
    const jql1 =
      'project = AIEAE AND issuetype in (Story, Bug, Epic) AND labels = EAE-Implementation ORDER BY Rank ASC';
    assert.deepEqual(extractRequiredLabelsFromJql(jql1), ['EAE-Implementation']);
    assert.deepEqual(extractRoutedIssueTypesFromJql(jql1), ['Story', 'Bug', 'Epic']);

    const jql2 =
      'project = "AIEAE" AND type = Initiative AND labels in ("EAE-Discovery")';
    assert.deepEqual(extractRequiredLabelsFromJql(jql2), ['EAE-Discovery']);
    assert.deepEqual(extractRoutedIssueTypesFromJql(jql2), ['Initiative']);
  });

  it('routes Jira+Jira multi-board workspaces on the same account by Issue Type, Label, and --board flag', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tkt-jirajira-'));
    try {
      const discoveryProfile: TktProfile = {
        name: 'eae-discovery',
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
            routedIssueTypes: ['Initiative'],
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

      const deliveryProfile: TktProfile = {
        ...discoveryProfile,
        name: 'eae-delivery',
        board: {
          id: '4887',
          name: 'AIEAE Implementation Board',
          boardType: 'kanban',
          archetype: 'kanban',
          boardUrl:
            'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4887',
          selectedTicketBoardUrlTemplate:
            'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4887?selectedIssue={key}',
          columns: [
            { columnName: 'Backlog', statuses: ['Backlog'], category: 'todo' },
            { columnName: 'In Progress', statuses: ['In Progress'], category: 'in_progress', wipMax: 5 },
            { columnName: 'Done', statuses: ['Closed'], category: 'done' },
          ],
          issueTypes: [],
          placement: {
            requiredLabels: ['EAE-Implementation'],
            routedIssueTypes: ['Story', 'Bug', 'Epic'],
          },
          syncedAt: new Date().toISOString(),
        },
      };

      upsertProfile(discoveryProfile, true, tmpDir);
      upsertProfile(deliveryProfile, false, tmpDir);
      generateBoardContextMarkdown(discoveryProfile, tmpDir);
      generateBoardContextMarkdown(deliveryProfile, tmpDir);

      // Verify .tktcraft/boards/INDEX.md is generated for multi-board workspace
      const indexPath = join(tmpDir, '.tktcraft', 'boards', 'INDEX.md');
      assert.ok(existsSync(indexPath));
      const indexMd = readFileSync(indexPath, 'utf-8');
      assert.ok(indexMd.includes('EAE Product Discovery & Intake'));
      assert.ok(indexMd.includes('AIEAE Implementation Board'));

      // 1. Auto-route by Issue Type (--type Story -> eae-delivery #4887; --type Initiative -> eae-discovery #4893)
      assert.equal(
        resolveActiveProfile({ issueTypeHint: 'Story', workspaceDir: tmpDir }).name,
        'eae-delivery'
      );
      assert.equal(
        resolveActiveProfile({ issueTypeHint: 'Initiative', workspaceDir: tmpDir }).name,
        'eae-discovery'
      );

      // 2. Auto-route by Label (--labels EAE-Implementation -> eae-delivery)
      assert.equal(
        resolveActiveProfile({
          labelsHint: ['EAE-Implementation'],
          workspaceDir: tmpDir,
        }).name,
        'eae-delivery'
      );

      // 3. Explicit --board selector (by board ID or name)
      assert.equal(
        resolveActiveProfile({ boardHint: '4887', workspaceDir: tmpDir }).name,
        'eae-delivery'
      );
      assert.equal(
        resolveActiveProfile({ boardHint: 'Discovery', workspaceDir: tmpDir }).name,
        'eae-discovery'
      );

      // 4. Cross-board ticket resolution for `tkt get`
      const matchedBoard = resolveMatchingBoardProfileForTicket(
        { issueType: 'Bug', labels: ['EAE-Implementation', 'frontend'] },
        discoveryProfile,
        tmpDir
      );
      assert.equal(matchedBoard.board.id, '4887');
      assert.equal(
        buildBoardViewUrl(matchedBoard, 'AIEAE-1900'),
        'https://exadel.atlassian.net/jira/software/c/projects/AIEAE/boards/4887?selectedIssue=AIEAE-1900'
      );

      // 5. Single-Account Isolation: switching to ADO replaces Jira profiles rather than mixing Jira+ADO
      const switchedAdoProfile: TktProfile = {
        ...discoveryProfile,
        name: 'ado-main',
        provider: 'ado',
        baseUrl: 'https://dev.azure.com/myorg',
      };
      const afterSwitch = upsertProfile(switchedAdoProfile, true, tmpDir);
      assert.equal(afterSwitch.provider, 'ado');
      assert.deepEqual(Object.keys(afterSwitch.profiles), ['ado-main']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes ADO+ADO multi-board workspaces on the same account by AreaPath and Issue Type', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tkt-adoado-'));
    try {
      const alphaBoard: TktProfile = {
        name: 'ado-team-alpha',
        provider: 'ado',
        baseUrl: 'https://dev.azure.com/myorg',
        project: 'CloudPlatform',
        board: {
          id: 'Alpha-Stories',
          name: 'Team Alpha — Stories',
          boardType: 'Stories',
          archetype: 'scrum',
          boardUrl: 'https://dev.azure.com/myorg/CloudPlatform/_boards/board/t/Team%20Alpha/Stories',
          selectedTicketBoardUrlTemplate:
            'https://dev.azure.com/myorg/CloudPlatform/_boards/board/t/Team%20Alpha/Stories?workitem={key}',
          columns: [
            { columnName: 'New', statuses: ['New'], category: 'todo' },
            {
              columnName: 'Active',
              statuses: ['Active'],
              category: 'in_progress',
              wipMax: 6,
              definitionOfDone: 'Unit tests passing & PR reviewed',
            },
          ],
          issueTypes: [],
          placement: {
            teamName: 'Team Alpha',
            defaultAreaPath: 'CloudPlatform\\Team Alpha',
            routedIssueTypes: ['User Story', 'Bug'],
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

      const portfolioBoard: TktProfile = {
        ...alphaBoard,
        name: 'ado-portfolio-epics',
        board: {
          ...alphaBoard.board,
          id: 'Portfolio-Epics',
          name: 'Portfolio — Epics',
          boardType: 'Epics',
          placement: {
            teamName: 'Portfolio',
            defaultAreaPath: 'CloudPlatform\\Portfolio',
            routedIssueTypes: ['Epic', 'Feature'],
          },
        },
      };

      upsertProfile(alphaBoard, true, tmpDir);
      upsertProfile(portfolioBoard, false, tmpDir);

      const cfg = loadWorkspaceConfig(tmpDir);
      assert.equal(cfg?.provider, 'ado');
      assert.equal(Object.keys(cfg?.profiles ?? {}).length, 2);

      // Route by AreaPath
      assert.equal(
        resolveActiveProfile({
          areaPathHint: 'CloudPlatform\\Portfolio',
          workspaceDir: tmpDir,
        }).name,
        'ado-portfolio-epics'
      );

      // Route by Work Item Type
      assert.equal(
        resolveActiveProfile({
          issueTypeHint: 'Epic',
          workspaceDir: tmpDir,
        }).name,
        'ado-portfolio-epics'
      );
      assert.equal(
        resolveActiveProfile({
          issueTypeHint: 'Bug',
          workspaceDir: tmpDir,
        }).name,
        'ado-team-alpha'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes Tier 2 Empirical Board Conventions from sampled board tickets', () => {
    const empirical = analyzeEmpiricalBoardConventions([
      {
        issueType: 'Story',
        summary: '[Context Management] Build token compaction pipeline',
        labels: ['EAE-Implementation', 'context-engine'],
        parentKey: 'AIEAE-100',
        description: '## The Story\nContext here\n## Acceptance Criteria\n- [ ] Works',
      },
      {
        issueType: 'Story',
        summary: '[Context Management] Add caching layer',
        labels: ['EAE-Implementation', 'caching'],
        parentKey: 'AIEAE-100',
        description: '## The Story\nCaching\n## Acceptance Criteria\n- [ ] Fast',
      },
      {
        issueType: 'Bug',
        summary: '[Execution Engine] Fix retry backoff overflow',
        labels: ['EAE-Implementation'],
        description: '## The Issue\nBug\n## Repro Steps\n1. Run',
      },
    ]);

    assert.equal(empirical.sampledTicketCount, 3);
    assert.equal(empirical.issueTypeCounts.Story, 2);
    assert.equal(empirical.issueTypeCounts.Bug, 1);
    assert.equal(empirical.activeLabelsVocabulary[0].label, 'EAE-Implementation');
    assert.ok(empirical.detectedTitlePattern?.includes('[<Domain/Module>]'));
    assert.equal(empirical.parentLinkPercentage, 67);
    assert.ok(empirical.commonDescriptionHeadings.includes('Acceptance Criteria'));
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
        join(tmpDir, '.tktcraft', 'audit.jsonl'),
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

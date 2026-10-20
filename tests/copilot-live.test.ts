import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBodyMatches, markerQuery, parseOptions, previewDigest, selectIssueType } from '../scripts/copilot-live.mjs';

describe('Opt-in live verification guards (no provider calls)', () => {
  it('defaults to preview and requires explicit board selection', () => {
    const options = parseOptions(['--provider', 'ado', '--project', 'TEST', '--board', 'board-1']);
    assert.equal(options.phase, 'preview-create');
    assert.throws(() => parseOptions(['--provider', 'ado', '--project', 'TEST']), /user-selected/);
    assert.throws(() => parseOptions(['--provider', 'ado', '--project', 'TEST', '--board', '1', '--token', 'not-a-token']), /never arguments/);
  });

  it('rejects write phases without the exact preview digest', () => {
    for (const phase of ['create', 'update']) {
      assert.throws(() => parseOptions(['--provider', 'jira', '--project', 'TEST', '--board', '1', '--phase', phase]), /explicit human approval/);
    }
    assert.notEqual(
      previewDigest('jira', 'TEST', '1', 'preview-create', { input: { summary: 'One' } }),
      previewDigest('jira', 'TEST', '1', 'preview-create', { input: { summary: 'Two' } })
    );
  });

  it('prefers the discovered PBI type over incidents and does not guess unsupported types', () => {
    assert.equal(selectIssueType('ado', {
      placement: { routedIssueTypes: ['Incident', 'PBI', 'User Story'] },
      issueTypes: [{ name: 'Task' }, { name: 'Incident' }, { name: 'PBI' }],
    }), 'PBI');
    assert.throws(() => selectIssueType('ado', { placement: {}, issueTypes: [{ name: 'Unknown' }] }), /select a supported type/);
  });

  it('uses board-filtered JQL for Jira and a board-scoped keyword for Azure', () => {
    assert.equal(markerQuery('jira', 'TEST', {
      placement: { filterQuery: 'project = TEST AND labels = team ORDER BY Rank ASC' },
    }, 'run-marker'), '(project = TEST AND labels = team) AND summary ~ "\\\"run-marker\\\""');
    assert.equal(markerQuery('ado', 'TEST', { placement: {} }, 'run-marker'), 'run-marker');
  });

  it('checks complete normalized body fields rather than a marker substring', () => {
    const description = '## Purpose\nA test.\n## Acceptance Criteria\n- Exact expected text.\n';
    assertBodyMatches('ado', { description: 'Purpose\nA test.', acceptanceCriteria: 'Exact expected text.' }, description);
    assertBodyMatches('jira', { description }, description);
    assert.throws(() => assertBodyMatches('ado', {
      description: 'Purpose\nA test.', acceptanceCriteria: 'Exact expected text. Unexpected addition.',
    }, description));
    assert.throws(() => assertBodyMatches('jira', { description: 'A test.' }, description));
  });
});

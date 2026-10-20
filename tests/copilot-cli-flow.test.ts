import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { upsertProfile } from '../src/config/manager.ts';
import { evaluateCopilotHook } from '../src/hooks/copilot.ts';
import type { TktProfile } from '../src/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

it('keeps CLI previews and simulated declined writes read-only, then preserves links for a mocked approved create', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'tkt mocked flow '));
  const queries: string[] = [];
  const mutations: Array<Array<{ path: string; value: unknown }>> = [];
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url?.includes('/_apis/wit/wiql?')) {
      queries.push(body);
      response.end('{"workItems":[]}');
    } else if (request.method === 'POST' && request.url?.includes('/_apis/wit/workitems/%24Task?')) {
      const patch: Array<{ path: string; value: unknown }> = JSON.parse(body);
      mutations.push(patch);
      const fields = Object.fromEntries(patch.map((entry) => [entry.path.replace('/fields/', ''), entry.value]));
      response.end(JSON.stringify({ id: 1, fields: {
        ...fields, 'System.TeamProject': 'TEST', 'System.WorkItemType': 'Task', 'System.State': 'New',
      } }));
    } else {
      unexpected.push(`${request.method} ${request.url}`);
      response.statusCode = 400;
      response.end('{"error":"Unexpected mocked endpoint"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const profile: TktProfile = {
      name: 'test', provider: 'ado', baseUrl, project: 'TEST', authType: 'pat',
      envVars: { url: 'TKT_TEST_URL', token: 'TKT_TEST_TOKEN' },
      governance: {
        forbidDelete: true, requireConfirmation: true, enforceBoardSchema: true,
        autoApplyBoardPlacement: true, auditLog: true,
      },
      board: {
        id: 'test-board', name: 'Test Board', boardType: 'kanban', archetype: 'kanban',
        boardUrl: `${baseUrl}/TEST/_boards/board/t/Team/Tasks`,
        selectedTicketBoardUrlTemplate: `${baseUrl}/TEST/_boards/board/t/Team/Tasks?workitem={key}`,
        columns: [{ columnName: 'Backlog', statuses: ['New'] }],
        issueTypes: [], placement: { requiredLabels: ['test-only'], defaultAreaPath: 'TEST\\Team' },
        syncedAt: '2026-10-20T00:00:00.000Z',
      },
    };
    upsertProfile(profile, true, workspace);
    const args = ['--experimental-strip-types', join(root, 'src/cli.ts'), 'create',
      '--type', 'Task', '--summary', 'Synthetic integration check', '--format', 'json'];
    const options = {
      cwd: workspace, timeout: 15000,
      env: { ...process.env, TKT_FORCE_YES: '0', TKT_TEST_URL: baseUrl, TKT_TEST_TOKEN: 'synthetic-test-only' },
    };
    const preview = JSON.parse((await exec(process.execPath, [...args, '--dry-run'], options)).stdout);
    assert.equal(preview.action, 'create.preview');
    assert.equal(preview.permissionRequired, true);
    assert.equal(preview.input.summary, 'Synthetic integration check');
    assert.equal(preview.effectiveAreaPath, 'TEST\\Team');
    assert.deepEqual(preview.effectiveLabels, ['test-only']);
    assert.deepEqual(preview.duplicatesFound, []);
    assert.equal(queries.length, 1);
    assert.equal(mutations.length, 0);

    const decision = evaluateCopilotHook(JSON.stringify({
      toolName: 'bash', cwd: workspace, toolArgs: { command: 'tkt create --summary "Synthetic integration check" --yes' },
    }), 'pre-tool');
    assert.equal(decision.permissionDecision, 'ask');
    // A simulated denial stops here: no CLI mutation is executed by the hook.
    assert.equal(mutations.length, 0);

    const approved = JSON.parse((await exec(process.execPath, [...args, '--yes'], options)).stdout);
    assert.equal(mutations.length, 1);
    assert.equal(approved.action, 'create');
    assert.equal(approved.data.summary, 'Synthetic integration check');
    assert.equal(approved.data.areaPath, 'TEST\\Team');
    assert.deepEqual(approved.data.labels, ['test-only']);
    assert.equal(approved.links.directUrl, `${baseUrl}/TEST/_workitems/edit/1`);
    assert.equal(approved.links.boardViewUrl, `${baseUrl}/TEST/_boards/board/t/Team/Tasks?workitem=1`);
    const post = evaluateCopilotHook(JSON.stringify({
      toolName: 'bash', cwd: workspace, toolArgs: { command: 'tkt create --yes' },
      toolResult: { resultType: 'success', textResultForLlm: JSON.stringify(approved) },
    }), 'post-tool');
    assert.ok(typeof post.additionalContext === 'string');
    assert.ok(post.additionalContext.includes(approved.links.directUrl));
    assert.ok(post.additionalContext.includes(approved.links.boardViewUrl));
    assert.deepEqual(unexpected, []);
  } finally {
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      assert.equal(existsSync(workspace), false);
    }
  }
});

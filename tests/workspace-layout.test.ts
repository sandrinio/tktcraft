import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getConfigPath, loadDotEnv, loadWorkspaceConfig, saveWorkspaceConfig, upsertDotEnvValues } from '../src/config/manager.ts';
import { getWorkspacePath } from '../src/config/paths.ts';
import { writePreHookApprovalToken } from '../src/hooks/agent-harness.ts';

function workspaceTest(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'tktcraft layout '));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    assert.equal(existsSync(workspace), false);
  }
}

describe('Canonical .tktcraft workspace layout', () => {
  it('writes credentials, config and approval state only inside the canonical home', () => {
    workspaceTest(workspace => {
      const envPath = upsertDotEnvValues({ JIRA_TOKEN: 'synthetic-token' }, workspace);
      const config = { version: 1 as const, defaultProfile: 'none', profiles: {} };
      saveWorkspaceConfig(config, workspace);
      writePreHookApprovalToken(workspace, 'cli-preview', 'Synthetic preview');
      assert.equal(envPath, join(workspace, '.tktcraft/.env'));
      assert.deepEqual(loadDotEnv(workspace), { JIRA_TOKEN: 'synthetic-token' });
      assert.deepEqual(loadWorkspaceConfig(workspace), config);
      assert.equal(existsSync(join(workspace, '.tktcraft/pending-approval.json')), true);
      assert.match(readFileSync(join(workspace, '.gitignore'), 'utf-8'), /^\.tktcraft\/$/m);
      if (process.platform === 'win32') {
        // One explicit full-control entry (the current user) and nothing inherited.
        const acl = spawnSync('icacls', [envPath], { encoding: 'utf-8' }).stdout;
        assert.equal(acl.match(/:\(/g)?.length, 1, acl);
        assert.match(acl, /:\(F\)/, acl);
      } else {
        assert.equal(statSync(envPath).mode & 0o777, 0o600);
      }
      assert.equal(existsSync(join(workspace, '.env')), false);
      assert.equal(existsSync(join(workspace, '.tkt')), false);
    });
  });

  it('retains root credential fallback without moving unrelated application settings', () => {
    workspaceTest(workspace => {
      const legacy = 'OTHER_APPLICATION_SECRET=leave-me-alone\nJIRA_TOKEN=legacy\n';
      writeFileSync(join(workspace, '.env'), legacy);
      assert.equal(loadDotEnv(workspace).JIRA_TOKEN, 'legacy');
      upsertDotEnvValues({ JIRA_TOKEN: 'canonical' }, workspace);
      assert.equal(loadDotEnv(workspace).JIRA_TOKEN, 'canonical');
      assert.equal(readFileSync(join(workspace, '.env'), 'utf-8'), legacy);
      assert.equal(readFileSync(join(workspace, '.tktcraft/.env'), 'utf-8').includes('OTHER_APPLICATION_SECRET'), false);
    });
  });

  it('migrates legacy state without losing audit, custom templates or pending state', () => {
    workspaceTest(workspace => {
      mkdirSync(join(workspace, '.tkt/templates'), { recursive: true });
      const config = { version: 1, defaultProfile: 'legacy', profiles: {} };
      writeFileSync(join(workspace, '.tkt/config.json'), JSON.stringify(config));
      writeFileSync(join(workspace, '.tkt/audit.jsonl'), '{"existing":true}\n');
      writeFileSync(join(workspace, '.tkt/templates/custom.md'), 'Custom template');
      writeFileSync(join(workspace, '.tkt/pending-approval.json'), '{"stagedAt":1}');
      assert.deepEqual(loadWorkspaceConfig(workspace), config);
      assert.equal(getConfigPath(workspace), join(workspace, '.tktcraft/config.json'));
      assert.equal(readFileSync(join(workspace, '.tktcraft/audit.jsonl'), 'utf-8'), '{"existing":true}\n');
      assert.equal(readFileSync(join(workspace, '.tktcraft/templates/custom.md'), 'utf-8'), 'Custom template');
      assert.equal(readFileSync(join(workspace, '.tktcraft/pending-approval.json'), 'utf-8'), '{"stagedAt":1}');
      assert.equal(existsSync(join(workspace, '.tkt')), false);
      assert.equal(getWorkspacePath(workspace, 'config.json'), getConfigPath(workspace));
    });
  });

  it('rejects competing state directories without silently selecting or overwriting either', () => {
    workspaceTest(workspace => {
      for (const directory of ['.tkt', '.tktcraft']) {
        mkdirSync(join(workspace, directory));
        writeFileSync(join(workspace, directory, 'config.json'), directory);
      }
      assert.throws(() => loadWorkspaceConfig(workspace), /Both .* exist.*neither was overwritten/);
      assert.equal(readFileSync(join(workspace, '.tkt/config.json'), 'utf-8'), '.tkt');
      assert.equal(readFileSync(join(workspace, '.tktcraft/config.json'), 'utf-8'), '.tktcraft');
      assert.equal(existsSync(join(workspace, '.gitignore')), false);
    });
  });
});

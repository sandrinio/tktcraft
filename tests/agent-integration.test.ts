import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { scaffoldWorkspaceAgentHarness } from '../src/setup/agent-integration.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copilotPath = '.github/hooks/tkt-governance.json';
const read = (workspace: string, path: string) => readFileSync(join(workspace, path), 'utf-8');
const put = (workspace: string, path: string, content: string) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), content);
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function workspaceTest(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'tkt integration '));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    assert.equal(existsSync(workspace), false);
  }
}

describe('Safe integration installation and upgrades', () => {
  it('migrates old managed assets and customized skill resources into the canonical home', () => {
    workspaceTest(workspace => {
      const oldBlock = '<!-- tktcraft:begin -->\nOld managed instructions\n<!-- tktcraft:end -->';
      const oldLauncher = 'Old managed launcher\n';
      const oldSkill = 'Old managed workflow\n';
      put(workspace, '.agents/tkt-hook.cjs', oldLauncher);
      put(workspace, '.agents/skills/tkt-ops/SKILL.md', oldSkill);
      put(workspace, '.agents/skills/tkt-ops/assets/custom.md', 'Keep this exact custom asset\n');
      put(workspace, '.agents/hooks.json', read(root, '.agents/hooks.json'));
      put(workspace, copilotPath, read(root, copilotPath));
      put(workspace, 'AGENTS.md', `User prefix\n${oldBlock}\nUser suffix\n`);
      put(workspace, '.tkt/agent-integration.json', JSON.stringify({
        version: 1, instructionsPath: 'AGENTS.md', files: {
          '.agents/tkt-hook.cjs': digest(oldLauncher),
          '.agents/skills/tkt-ops/SKILL.md': digest(oldSkill),
          'AGENTS.md#tktcraft': digest(oldBlock),
        },
      }));
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(existsSync(join(workspace, '.tkt')), false);
      assert.match(read(workspace, '.tktcraft/hooks/tkt-hook.cjs'), /require\(launcher\)/);
      assert.match(read(workspace, '.agents/tkt-hook.cjs'), /\.tktcraft\/hooks\/tkt-hook.cjs/);
      assert.match(read(workspace, '.agents/skills/tkt-ops/SKILL.md'), /tktcraft:skill-entry/);
      assert.match(read(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), /Unified Jira/);
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/assets/custom.md'), 'Keep this exact custom asset\n');
      assert.equal(existsSync(join(workspace, '.agents/skills/tkt-ops/assets')), false);
      assert.ok(read(workspace, 'AGENTS.md').startsWith('User prefix\n'));
      assert.ok(read(workspace, 'AGENTS.md').endsWith('\nUser suffix\n'));
      const manifest = read(workspace, '.tktcraft/agent-integration.json');
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, '.tktcraft/agent-integration.json'), manifest);
    });
  });

  it('preserves canonical workflow customizations across repeat setup', () => {
    workspaceTest(workspace => {
      scaffoldWorkspaceAgentHarness(workspace);
      put(workspace, '.tktcraft/skills/tkt-ops/SKILL.md', 'Custom canonical workflow\n');
      const result = scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'Custom canonical workflow\n');
      assert.ok(result.preservedFiles.includes('.tktcraft/skills/tkt-ops/SKILL.md'));
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'Custom canonical workflow\n');
    });
  });

  it('reports competing customized skill copies before changing either', () => {
    workspaceTest(workspace => {
      put(workspace, '.agents/skills/tkt-ops/SKILL.md', 'Legacy custom workflow\n');
      put(workspace, '.tktcraft/skills/tkt-ops/SKILL.md', 'Different canonical workflow\n');
      assert.throws(() => scaffoldWorkspaceAgentHarness(workspace), /Conflicting skill assets/);
      assert.equal(read(workspace, '.agents/skills/tkt-ops/SKILL.md'), 'Legacy custom workflow\n');
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'Different canonical workflow\n');
      assert.equal(existsSync(join(workspace, copilotPath)), false);
    });
  });
  it('installs one cross-harness registration and minimal instructions without claiming activation', () => {
    workspaceTest((workspace) => {
      const result = scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(result.status, 'installed');
      assert.equal(result.verifiedActive, false);
      assert.equal(result.instructionsPath, 'AGENTS.md');
      const hooks = JSON.parse(read(workspace, copilotPath));
      assert.equal(hooks.version, 1);
      assert.deepEqual(Object.keys(hooks.hooks).sort(), ['postToolUse', 'preToolUse']);
      assert.equal(hooks.hooks.preToolUse.length, 1);
      assert.match(hooks.hooks.preToolUse[0].command, /copilot-pre-tool/);
      assert.deepEqual(readdirSync(join(workspace, '.github/hooks')), ['tkt-governance.json']);
      assert.match(read(workspace, 'AGENTS.md'), /\.tktcraft\/skills\/tkt-ops\/SKILL.md/);
      assert.match(read(workspace, 'AGENTS.md'), /\.tktcraft\/boards\/INDEX.md/);
      assert.match(read(workspace, '.gitignore'), /^\.env$/m);
      assert.match(read(workspace, '.gitignore'), /^\.tktcraft\/$/m);
      assert.equal(existsSync(join(workspace, '.tktcraft/skills/tkt-ops/assets/task_template.md')), true);
    });
  });

  it('preserves unrelated hooks and instruction text byte-for-byte and remains idempotent', () => {
    workspaceTest((workspace) => {
      const unrelated = '{ "hooks": { "preToolUse": [] }, "custom": true }\n';
      const userText = '# User instructions\r\n\r\nKeep my exact formatting.\r\n';
      put(workspace, '.github/hooks/user.json', unrelated);
      put(workspace, 'AGENTS.md', userText);
      scaffoldWorkspaceAgentHarness(workspace);
      const first = read(workspace, 'AGENTS.md');
      const manifest = read(workspace, '.tktcraft/agent-integration.json');
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, '.github/hooks/user.json'), unrelated);
      assert.ok(first.startsWith(userText));
      assert.equal(read(workspace, 'AGENTS.md'), first);
      assert.equal(read(workspace, '.tktcraft/agent-integration.json'), manifest);
      assert.equal(first.split('<!-- tktcraft:begin -->').length, 2);
    });
  });

  it('reuses existing Copilot instructions when there is no AGENTS entry point', () => {
    workspaceTest((workspace) => {
      put(workspace, '.github/copilot-instructions.md', '# Existing Copilot guidance\n');
      const result = scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(result.instructionsPath, '.github/copilot-instructions.md');
      assert.equal(existsSync(join(workspace, 'AGENTS.md')), false);
      assert.ok(read(workspace, result.instructionsPath).startsWith('# Existing Copilot guidance\n'));
      assert.match(read(workspace, result.instructionsPath), /\.\.\/\.tktcraft\/skills/);
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, result.instructionsPath).split('<!-- tktcraft:begin -->').length, 2);
    });
  });

  it('updates unmodified managed assets and blocks while preserving surrounding user edits', () => {
    workspaceTest((workspace) => {
      scaffoldWorkspaceAgentHarness(workspace);
      const manifest = JSON.parse(read(workspace, '.tktcraft/agent-integration.json'));
      for (const path of [copilotPath, '.tktcraft/hooks/tkt-hook.cjs', '.tktcraft/skills/tkt-ops/assets/task_template.md']) {
        const old = `previous generated version of ${path}\n`;
        put(workspace, path, old);
        manifest.files[path] = digest(old);
      }
      const oldBlock = '<!-- tktcraft:begin -->\nprevious instructions\n<!-- tktcraft:end -->';
      put(workspace, 'AGENTS.md', `User prefix\n${oldBlock}\nUser suffix\n`);
      manifest.files['AGENTS.md#tktcraft'] = digest(oldBlock);
      put(workspace, '.tktcraft/agent-integration.json', JSON.stringify(manifest));
      scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, copilotPath), read(root, copilotPath).replaceAll('node .agents/tkt-hook.cjs', 'node .tktcraft/hooks/tkt-hook.cjs'));
      assert.match(read(workspace, '.tktcraft/hooks/tkt-hook.cjs'), /require\(launcher\)/);
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/assets/task_template.md'), read(root, '.agents/skills/tkt-ops/assets/task_template.md'));
      assert.ok(read(workspace, 'AGENTS.md').startsWith('User prefix\n'));
      assert.ok(read(workspace, 'AGENTS.md').endsWith('\nUser suffix\n'));
      assert.equal(read(workspace, 'AGENTS.md').includes('previous instructions'), false);
    });
  });

  it('preserves customized skills and installs missing skill assets alongside them', () => {
    workspaceTest((workspace) => {
      put(workspace, '.agents/skills/tkt-ops/SKILL.md', 'User skill\n');
      const result = scaffoldWorkspaceAgentHarness(workspace);
      assert.equal(read(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'User skill\n');
      assert.match(read(workspace, '.agents/skills/tkt-ops/SKILL.md'), /tktcraft:skill-entry/);
      assert.deepEqual(result.preservedFiles, ['.tktcraft/skills/tkt-ops/SKILL.md']);
      assert.equal(existsSync(join(workspace, '.tktcraft/skills/tkt-ops/assets/story_template.md')), true);
      assert.equal(existsSync(join(workspace, copilotPath)), true);
    });
  });

  it('preflights conflicts before installing anything or modifying existing files', () => {
    for (const [path, content] of [
      [copilotPath, '{"custom":true}\n'],
      ['AGENTS.md', '<!-- tktcraft:begin -->\ncustom\n<!-- tktcraft:end -->\n'],
      ['AGENTS.md', '<!-- tktcraft:begin -->\nunclosed\n'],
      ['AGENTS.md', '<!-- tktcraft:end -->\n'],
      ['AGENTS.md', '<!-- tktcraft:begin --><!-- tktcraft:begin --><!-- tktcraft:end -->'],
    ]) {
      workspaceTest((workspace) => {
        put(workspace, path, content);
        assert.throws(() => scaffoldWorkspaceAgentHarness(workspace), /not overwritten/);
        assert.equal(read(workspace, path), content);
        assert.equal(existsSync(join(workspace, '.tktcraft/hooks/tkt-hook.cjs')), false);
        assert.equal(existsSync(join(workspace, '.tktcraft/agent-integration.json')), false);
        assert.equal(existsSync(join(workspace, '.gitignore')), false);
      });
    }
  });

  it('detects user edits to managed hook assets after setup without losing them', () => {
    workspaceTest((workspace) => {
      scaffoldWorkspaceAgentHarness(workspace);
      const customized = `${read(workspace, copilotPath)} \n`;
      put(workspace, copilotPath, customized);
      assert.throws(() => scaffoldWorkspaceAgentHarness(workspace), /not overwritten/);
      assert.equal(read(workspace, copilotPath), customized);
    });
  });

  it('rejects malformed manifests rather than forgetting customization history', () => {
    for (const value of [
      '{bad',
      '{"version":2,"files":{},"instructionsPath":"AGENTS.md"}',
      '{"version":1,"files":{"bad":"not a hash"},"instructionsPath":"AGENTS.md"}',
      '{"version":1,"files":{},"instructionsPath":"../external.md"}',
    ]) {
      workspaceTest((workspace) => {
        put(workspace, '.tktcraft/agent-integration.json', value);
        assert.throws(() => scaffoldWorkspaceAgentHarness(workspace), /manifest|configuration|hash/);
        assert.equal(read(workspace, '.tktcraft/agent-integration.json'), value);
        assert.equal(existsSync(join(workspace, copilotPath)), false);
      });
    }
  });
});

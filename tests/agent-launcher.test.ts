import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { scaffoldWorkspaceAgentHarness } from '../src/setup/wizard.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readHooks = (workspace: string) =>
  JSON.parse(readFileSync(join(workspace, '.agents', 'hooks.json'), 'utf-8'));

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'tkt workspace '));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    assert.equal(existsSync(workspace), false);
  }
}

describe('Installed-package hook launcher', () => {
  it('runs both registered hooks in an unrelated workspace with no package bin directory', () => {
    withWorkspace((workspace) => {
      scaffoldWorkspaceAgentHarness(workspace);
      const hooks = readHooks(workspace)['tkt-board-governance'];
      for (const event of ['PreToolUse', 'PostToolUse']) {
        const result = spawnSync(hooks[event][0].hooks[0].command, {
          shell: true,
          cwd: workspace,
          input: JSON.stringify({
            toolCall: { name: 'run_command', args: { CommandLine: 'tkt search --board-only' } },
          }),
          encoding: 'utf-8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), event === 'PreToolUse' ? { decision: 'allow' } : {});
      }
      assert.equal(existsSync(join(workspace, 'bin')), false);
    });
  });

  it('preserves denial and confirmation decisions across the executable boundary', () => {
    withWorkspace((workspace) => {
      scaffoldWorkspaceAgentHarness(workspace);
      for (const [command, expected] of [
        ['tkt delete TEST-1', 'deny'],
        ['tkt update TEST-1 --summary Test --yes', 'force_ask'],
        ['tkt create --summary Test --dry-run', 'allow'],
      ]) {
        const result = spawnSync(process.execPath, ['.tktcraft/hooks/tkt-hook.cjs', 'pre-tool'], {
          cwd: workspace,
          input: JSON.stringify({
            toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: workspace } },
          }),
          encoding: 'utf-8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).decision, expected);
      }
    });
  });

  it('installs missing hook assets when the shared skill already exists and is repeatable', () => {
    withWorkspace((workspace) => {
      const skillDir = join(workspace, '.agents', 'skills', 'tkt-ops');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'Customized skill\n');
      const unrelated = { custom: { PreToolUse: [{ command: 'echo custom' }] } };
      writeFileSync(join(workspace, '.agents', 'hooks.json'), JSON.stringify(unrelated));

      scaffoldWorkspaceAgentHarness(workspace);
      const firstHooks = readFileSync(join(workspace, '.agents', 'hooks.json'), 'utf-8');
      const firstLauncher = readFileSync(join(workspace, '.tktcraft', 'hooks', 'tkt-hook.cjs'), 'utf-8');
      scaffoldWorkspaceAgentHarness(workspace);

      assert.equal(readFileSync(join(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'utf-8'), 'Customized skill\n');
      assert.deepEqual(readHooks(workspace).custom, unrelated.custom);
      assert.equal(readFileSync(join(workspace, '.agents', 'hooks.json'), 'utf-8'), firstHooks);
      assert.equal(readFileSync(join(workspace, '.tktcraft', 'hooks', 'tkt-hook.cjs'), 'utf-8'), firstLauncher);
      assert.equal(readHooks(workspace)['tkt-board-governance'].PreToolUse.length, 1);
    });
  });

  it('upgrades the exact legacy registration while retaining unrelated hooks', () => {
    withWorkspace((workspace) => {
      mkdirSync(join(workspace, '.agents'));
      const original = readFileSync(join(root, '.agents', 'hooks.json'), 'utf-8');
      const legacy = JSON.parse(original.replaceAll('node .agents/tkt-hook.cjs', 'node ../bin/tkt.js hook'));
      legacy.custom = { enabled: true };
      writeFileSync(join(workspace, '.agents', 'hooks.json'), JSON.stringify(legacy));
      scaffoldWorkspaceAgentHarness(workspace);
      assert.deepEqual(readHooks(workspace).custom, legacy.custom);
      assert.equal(
        readHooks(workspace)['tkt-board-governance'].PreToolUse[0].hooks[0].command,
        'node .tktcraft/hooks/tkt-hook.cjs pre-tool'
      );
    });
  });

  it('reports customized registrations and launchers instead of overwriting them', () => {
    for (const file of ['hooks.json', 'tkt-hook.cjs']) {
      withWorkspace((workspace) => {
        mkdirSync(join(workspace, '.agents'));
        const target = join(workspace, '.agents', file);
        const content = file === 'hooks.json'
          ? JSON.stringify({ 'tkt-board-governance': { custom: true } })
          : 'console.log("custom launcher");\n';
        writeFileSync(target, content);
        assert.throws(() => scaffoldWorkspaceAgentHarness(workspace), /not overwritten/);
        assert.equal(readFileSync(target, 'utf-8'), content);
        assert.equal(existsSync(join(workspace, '.agents', 'skills')), false);
      });
    }
  });

  it('reports malformed hook configuration without replacing it', () => {
    withWorkspace((workspace) => {
      mkdirSync(join(workspace, '.agents'));
      const target = join(workspace, '.agents', 'hooks.json');
      for (const content of ['{invalid', '[]', 'null']) {
        writeFileSync(target, content);
        assert.throws(() => scaffoldWorkspaceAgentHarness(workspace));
        assert.equal(readFileSync(target, 'utf-8'), content);
      }
    });
  });

  it('resolves the package that ran setup even when its path contains shell metacharacters', () => {
    withWorkspace((temporary) => {
      const packageRoot = join(temporary, "installed package $ ' &", 'node_modules', 'tktcraft');
      const workspace = join(temporary, 'consumer project');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(workspace);
      for (const entry of ['package.json', 'bin', '.agents', '.github/hooks']) {
        mkdirSync(dirname(join(packageRoot, entry)), { recursive: true });
        cpSync(join(root, entry), join(packageRoot, entry), { recursive: true });
      }
      const build = spawnSync(process.execPath, [
        join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--project', join(root, 'tsconfig.json'),
        '--outDir', join(packageRoot, 'dist'),
      ], { encoding: 'utf-8' });
      assert.equal(build.status, 0, build.stdout + build.stderr);
      const wizardUrl = pathToFileURL(join(packageRoot, 'dist', 'setup', 'wizard.js')).href;
      const setup = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `import { scaffoldWorkspaceAgentHarness } from ${JSON.stringify(wizardUrl)}; scaffoldWorkspaceAgentHarness();`,
      ], { cwd: workspace, encoding: 'utf-8' });
      assert.equal(setup.status, 0, setup.stderr);
      const hook = spawnSync(process.execPath, ['.tktcraft/hooks/tkt-hook.cjs', 'pre-tool'], {
        cwd: workspace,
        input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"tkt search"}}}',
        encoding: 'utf-8',
      });
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(JSON.parse(hook.stdout).decision, 'allow');

      rmSync(join(packageRoot, 'bin', 'tkt-hook.cjs'));
      const missing = spawnSync(process.execPath, ['.tktcraft/hooks/tkt-hook.cjs', 'pre-tool'], {
        cwd: workspace, input: '{}', encoding: 'utf-8',
      });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Reinstall tktcraft and rerun tkt setup/);
      assert.equal(missing.stdout, '');
      const retry = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `import { scaffoldWorkspaceAgentHarness } from ${JSON.stringify(wizardUrl)}; scaffoldWorkspaceAgentHarness();`,
      ], { cwd: workspace, encoding: 'utf-8' });
      assert.notEqual(retry.status, 0);
      assert.match(retry.stderr, /Missing tktcraft integration asset/);
    });
  });

  it('fails explicitly for invalid launcher modes and missing CLI assets', () => {
    withWorkspace((workspace) => {
      cpSync(join(root, 'bin', 'tkt-hook.cjs'), join(workspace, 'tkt-hook.cjs'));
      const invalid = spawnSync(process.execPath, ['tkt-hook.cjs', 'invalid'], {
        cwd: workspace, encoding: 'utf-8',
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /expected pre-tool or post-tool/);
      const missing = spawnSync(process.execPath, ['tkt-hook.cjs', 'pre-tool'], {
        cwd: workspace, encoding: 'utf-8',
      });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /missing bin\/tkt.js/);

      cpSync(join(root, 'bin', 'tkt.js'), join(workspace, 'tkt.js'));
      const assets = spawnSync(process.execPath, ['tkt-hook.cjs', 'pre-tool'], {
        cwd: workspace, input: '{}', encoding: 'utf-8',
      });
      assert.equal(assets.status, 1);
      assert.match(assets.stderr, /Reinstall tktcraft/);
    });
  });
});

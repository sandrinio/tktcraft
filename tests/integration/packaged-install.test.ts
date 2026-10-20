import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(command: string, args: string[], cwd: string, input?: string): string {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf-8', timeout: 60000 });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  return result.stdout;
}

it('installs the candidate npm archive and runs both registered hook contracts in an unrelated workspace', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'tkt packaged integration '));
  try {
    const [packed] = JSON.parse(run('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
    ], root));
    const files: string[] = packed.files.map((file: { path: string }) => file.path);
    for (const required of [
      'bin/tkt.js', 'bin/tkt-hook.cjs', '.agents/tkt-hook.cjs', '.agents/hooks.json',
      '.agents/skills/tkt-ops/SKILL.md', '.github/hooks/tkt-governance.json',
      'dist/hooks/copilot.js', 'dist/setup/agent-integration.js', 'dist/config/paths.js', 'ONBOARDING.md',
      'COPILOT-COMPATIBILITY.md',
    ]) assert.ok(files.includes(required), `Missing packed asset: ${required}`);
    assert.equal(files.some((file) => /(^|\/)\.env$|(^|\/)\.tkt(?:craft)?\/|^\.github\/workflows\//.test(file)), false);

    const workspace = join(temporary, 'unrelated consumer project');
    mkdirSync(workspace);
    // Reuse the already-installed type-only dependency without network or cache assumptions.
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: 'tkt-package-test', private: true, type: 'module',
      dependencies: { 'undici-types': pathToFileURL(join(root, 'node_modules/undici-types')).href },
    }));
    run('npm', [
      'install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--package-lock=false', join(temporary, packed.filename),
    ], workspace);
    const wizard = pathToFileURL(join(workspace, 'node_modules/tktcraft/dist/setup/wizard.js')).href;
    const setup = JSON.parse(run(process.execPath, ['--input-type=module', '-e',
      `import { scaffoldWorkspaceAgentHarness } from ${JSON.stringify(wizard)}; scaffoldWorkspaceAgentHarness(); console.log(JSON.stringify(scaffoldWorkspaceAgentHarness()));`,
    ], workspace));
    assert.equal(setup.status, 'installed');
    assert.equal(setup.verifiedActive, false);
    const config = JSON.parse(readFileSync(join(workspace, '.github/hooks/tkt-governance.json'), 'utf-8'));
    const pre = config.hooks.preToolUse[0].command;
    const post = config.hooks.postToolUse[0].command;
    assert.match(pre, /^node \.tktcraft\/hooks\/tkt-hook\.cjs /);
    const skill = readFileSync(join(workspace, '.agents/skills/tkt-ops/SKILL.md'), 'utf-8');
    assert.match(skill, /tktcraft:skill-entry/);
    assert.ok(skill.length < 1500, 'Discovery entry must stay small, not duplicate the workflow.');
    assert.match(readFileSync(join(workspace, '.tktcraft/skills/tkt-ops/SKILL.md'), 'utf-8'), /Unified Jira/);
    assert.equal(existsSync(join(workspace, '.agents/skills/tkt-ops/assets')), false);
    assert.equal(existsSync(join(workspace, '.agents/tkt-hook.cjs')), false);
    run(process.execPath, ['node_modules/tktcraft/bin/tkt.js', 'template', '--init'], workspace);
    assert.ok(existsSync(join(workspace, '.tktcraft/templates/task_template.md')));
    assert.equal(existsSync(join(workspace, '.tkt')), false);
    for (const local of [false, true]) {
      const payload = local
        ? { hook_event_name: 'PreToolUse', cwd: workspace, tool_name: 'synthetic-terminal', tool_input: { command: 'tkt update TEST-1 --yes' } }
        : { cwd: workspace, toolName: 'bash', toolArgs: { command: 'tkt update TEST-1 --yes' } };
      const result = spawnSync(pre, { shell: true, cwd: workspace, input: JSON.stringify(payload), encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(local ? output.hookSpecificOutput.permissionDecision : output.permissionDecision, 'ask');
      const links = 'Direct Link: https://example.invalid/TEST-1\nBoard Link: https://example.invalid/board/1';
      const postPayload = local
        ? { ...payload, hook_event_name: 'PostToolUse', tool_response: links }
        : { ...payload, toolResult: { resultType: 'success', textResultForLlm: links } };
      const reminder = spawnSync(post, { shell: true, cwd: workspace, input: JSON.stringify(postPayload), encoding: 'utf-8' });
      assert.equal(reminder.status, 0, reminder.stderr);
      const parsed = JSON.parse(reminder.stdout);
      const context = local ? parsed.hookSpecificOutput.additionalContext : parsed.additionalContext;
      assert.ok(context.includes('https://example.invalid/TEST-1'));
      assert.ok(context.includes('https://example.invalid/board/1'));
    }
    const invalid = spawnSync(pre, { shell: true, cwd: workspace, input: '{bad', encoding: 'utf-8' });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /\[tkt Copilot Hook\]/);
    assert.match(run(process.execPath, ['node_modules/tktcraft/bin/tkt.js', 'onboarding'], workspace), /Zero-to-One/);
    rmSync(join(workspace, 'node_modules/tktcraft/bin/tkt-hook.cjs'));
    const missing = spawnSync(pre, { shell: true, cwd: workspace, input: '{}', encoding: 'utf-8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Reinstall tktcraft/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    assert.equal(existsSync(temporary), false);
  }
});

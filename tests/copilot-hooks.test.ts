import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { evaluateCopilotHook } from '../src/hooks/copilot.ts';
import { evaluatePreToolUsePayload } from '../src/hooks/agent-harness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'copilot-hook-contracts.json'), 'utf-8'));
const links = { directUrl: 'https://example.invalid/ticket/TEST-1', boardViewUrl: 'https://example.invalid/board/1' };

function workspaceTest(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'tkt copilot '));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    assert.equal(existsSync(workspace), false);
  }
}

function payload(harness: 'local' | 'copilot', mode: 'pre' | 'post', command: string, workspace: string, result?: unknown) {
  const fixture = { ...fixtures[harness][`${mode}Input`], cwd: workspace };
  if (harness === 'local') {
    fixture.tool_name = 'synthetic-terminal-tool';
    fixture.tool_input = { command };
    if (mode === 'post') fixture.tool_response = result;
  } else {
    fixture.toolArgs = { command };
    if (mode === 'post') fixture.toolResult = result;
  }
  return JSON.stringify(fixture);
}

describe('Copilot hook contracts (synthetic commands, documented and observed envelopes)', () => {
  it('replays the observed SDK read-only shape with sanitized values', () => {
    workspaceTest((workspace) => {
      const observed = fixtures.observedCopilot;
      const preInput = { ...observed.preInput, cwd: workspace };
      assert.deepEqual(evaluateCopilotHook(JSON.stringify(preInput), 'pre-tool'), observed.preOutput);
      const postInput = {
        ...preInput,
        toolResult: { resultType: 'success', textResultForLlm: JSON.stringify({ key: 'TEST-1', ...links }) },
      };
      assert.deepEqual(Object.keys(postInput), observed.postInputKeys);
      assert.deepEqual(Object.keys(postInput.toolResult), observed.postResultKeys);
      const output = evaluateCopilotHook(JSON.stringify(postInput), 'post-tool');
      assert.deepEqual(Object.keys(output), observed.postOutputKeys);
      assert.ok(typeof output.additionalContext === 'string');
      assert.ok(output.additionalContext.includes(links.directUrl));
      assert.ok(output.additionalContext.includes(links.boardViewUrl));
    });
  });

  for (const harness of ['local', 'copilot'] as const) {
    it(`${harness}: preserves normal permissions for reads, previews, and unrelated tools`, () => {
      workspaceTest((workspace) => {
        for (const command of [
          'tkt search --board-only', 'tkt board-schema', 'npm test', 'tkt create --summary Test --dry-run',
          'npx --no-install tkt create --summary "A title" --dry-run',
          'node "./bin/tkt.js" create --summary "A title" --dry-run',
        ]) {
          assert.deepEqual(evaluateCopilotHook(payload(harness, 'pre', command, workspace), 'pre-tool'), {});
        }
        const nonterminal = harness === 'local'
          ? { hook_event_name: 'PreToolUse', tool_name: 'view', tool_input: { path: 'README.md' } }
          : { toolName: 'view', toolArgs: { path: 'README.md' } };
        assert.deepEqual(evaluateCopilotHook(JSON.stringify(nonterminal), 'pre-tool'), {});
      });
    });

    it(`${harness}: denies deletion and asks for writes in the native output envelope`, () => {
      workspaceTest((workspace) => {
        for (const [command, expected] of [
          ['tkt delete TEST-1', 'deny'],
          ['az boards work-item delete --id 1', 'deny'],
          ['tkt create --summary Test --yes', 'ask'],
          ['tkt update TEST-1 --summary Changed --yes', 'ask'],
          ['jira issue edit TEST-1', 'ask'],
        ]) {
          const output = evaluateCopilotHook(payload(harness, 'pre', command, workspace), 'pre-tool');
          const decision = harness === 'local' ? output.hookSpecificOutput : output;
          assert.ok(typeof decision === 'object' && decision !== null);
          assert.equal('permissionDecision' in decision && decision.permissionDecision, expected);
          assert.ok('permissionDecisionReason' in decision && typeof decision.permissionDecisionReason === 'string');
          assert.equal(Object.hasOwn(output, 'decision'), false);
        }
        const staged = JSON.parse(readFileSync(join(workspace, '.tktcraft', 'pending-approval.json'), 'utf-8'));
        assert.equal(staged.source, 'pre-tool-hook');
      });
    });

    it(`${harness}: does not let a quoted or chained dry-run marker pre-approve a write`, () => {
      workspaceTest((workspace) => {
        for (const command of [
          'tkt update TEST-1 --summary "--dry-run" --yes',
          'tkt create --dry-run && tkt update TEST-1 --yes',
          'tkt create --dry-run; tkt update TEST-1 --yes',
          'tkt create --summary "$(tkt update TEST-1 --yes)" --dry-run',
          'tkt update TEST-1 --summary foo\\ --dry-run --yes',
          'tkt update TEST-1 --DRY-RUN --yes',
          "sh -c 'tkt update TEST-1 --yes' --dry-run",
        ]) {
          const output = evaluateCopilotHook(payload(harness, 'pre', command, workspace), 'pre-tool');
          const decision = harness === 'local' ? output.hookSpecificOutput : output;
          assert.ok(typeof decision === 'object' && decision !== null);
          assert.equal('permissionDecision' in decision && decision.permissionDecision, 'ask');
        }
      });
    });

    it(`${harness}: preserves both post-hook links across all CLI output formats`, () => {
      workspaceTest((workspace) => {
        const outputs = [
          `Direct Link: ${links.directUrl}\nBoard Link: ${links.boardViewUrl}`,
          `| **Direct Ticket Link** | ${links.directUrl} |\n| **Board View Link** | ${links.boardViewUrl} |`,
          JSON.stringify({ ok: true, action: 'update', links }),
          JSON.stringify({ key: 'TEST-1', ...links }),
          { stdout: JSON.stringify({ links }) },
          { content: [{ type: 'text', text: JSON.stringify({ links }) }] },
        ];
        for (const text of outputs) {
          const result = harness === 'copilot' && typeof text === 'string'
            ? { resultType: 'success', textResultForLlm: text }
            : text;
          const output = evaluateCopilotHook(payload(harness, 'post', 'tkt update TEST-1 --yes', workspace, result), 'post-tool');
          const context = harness === 'local' ? output.hookSpecificOutput : output;
          assert.ok(typeof context === 'object' && context !== null);
          assert.ok('additionalContext' in context && typeof context.additionalContext === 'string');
          if ('additionalContext' in context && typeof context.additionalContext === 'string') {
            assert.ok(context.additionalContext.includes(links.directUrl));
            assert.ok(context.additionalContext.includes(links.boardViewUrl));
          }
        }
      });
    });

    it(`${harness}: reports missing links and malformed relevant results, not successful writes`, () => {
      workspaceTest((workspace) => {
        for (const result of [
          'Created TEST-1', `Direct Link: ${links.directUrl}`, null, { exitCode: 1, stdout: 'error' },
        ]) {
          assert.throws(
            () => evaluateCopilotHook(payload(harness, 'post', 'tkt create --yes', workspace, result), 'post-tool'),
            /missing|Unsupported|failed/
          );
        }
        assert.deepEqual(evaluateCopilotHook(payload(harness, 'post', 'tkt create --dry-run', workspace, 'Preview only'), 'post-tool'), {});
        assert.deepEqual(evaluateCopilotHook(payload(harness, 'post', 'tkt search', workspace, 'No matches'), 'post-tool'), {});
        assert.deepEqual(evaluateCopilotHook(payload(harness, 'post', 'npm test', workspace, undefined), 'post-tool'), {});
      });
    });
  }

  it('normalizes encoded arguments and uses the payload working directory', () => {
    workspaceTest((workspace) => {
      const output = evaluateCopilotHook(JSON.stringify({
        toolName: 'powershell', cwd: workspace,
        toolArgs: JSON.stringify({ command: 'tkt update TEST-1 --yes' }),
      }), 'pre-tool', root);
      assert.equal(output.permissionDecision, 'ask');
      assert.equal(existsSync(join(workspace, '.tktcraft', 'pending-approval.json')), true);
    });
  });

  it('surfaces malformed envelopes and commands explicitly', () => {
    for (const input of [
      '', '{bad', 'null', '[]', '{}',
      '{"toolName":"bash","toolArgs":"not JSON"}',
      '{"toolName":"bash","toolArgs":{"command":42}}',
      '{"toolName":"bash","toolArgs":{"command":""}}',
      '{"toolName":"bash","toolArgs":{"command":"tkt update","cwd":42}}',
      '{"tool_name":"terminal","hook_event_name":"PostToolUse","tool_input":{}}',
      '{"tool_name":"bash","toolName":"bash","hook_event_name":"PreToolUse","tool_input":{}}',
    ]) {
      assert.throws(() => evaluateCopilotHook(input, 'pre-tool'));
    }
  });

  it('surfaces staging failures instead of claiming that a preview or approval was recorded', () => {
    workspaceTest((workspace) => {
      writeFileSync(join(workspace, '.tktcraft'), 'not a directory');
      assert.throws(() => evaluateCopilotHook(payload('copilot', 'pre', 'tkt create --dry-run', workspace), 'pre-tool'));
    });
  });

  it('retains the legacy decision envelope and permissive legacy malformed-input contract', () => {
    assert.deepEqual(evaluatePreToolUsePayload('{bad'), { decision: 'allow' });
    assert.equal(evaluatePreToolUsePayload('{"toolCall":{"name":"run_command","args":{"CommandLine":"tkt delete TEST-1"}}}').decision, 'deny');
  });

  it('serializes native JSON and exits 2 on malformed input at the executable boundary', () => {
    workspaceTest((workspace) => {
      for (const harness of ['local', 'copilot'] as const) {
        const success = spawnSync(process.execPath, [
          '--experimental-strip-types', join(root, 'src', 'cli.ts'), 'hook', 'copilot-pre-tool',
        ], { cwd: workspace, input: payload(harness, 'pre', 'tkt delete TEST-1', workspace), encoding: 'utf-8' });
        assert.equal(success.status, 0, success.stderr);
        const output = JSON.parse(success.stdout);
        assert.equal(harness === 'local' ? output.hookSpecificOutput.permissionDecision : output.permissionDecision, 'deny');
      }
      const failure = spawnSync(process.execPath, [
        '--experimental-strip-types', join(root, 'src', 'cli.ts'), 'hook', 'copilot-pre-tool',
      ], { cwd: workspace, input: '{bad', encoding: 'utf-8' });
      assert.equal(failure.status, 2);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /\[tkt Copilot Hook\].*valid JSON/);
    });
  });
});

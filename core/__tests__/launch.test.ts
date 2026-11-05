import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs, launchAgent } from '../src/agent/launch.ts';
import { instancePaths } from '../src/home.ts';

/** Stands in for `claude`: behaviour is picked with FAKE_MODE, and it reports what it was given. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const mode = process.env.FAKE_MODE;
out({ type: 'system', subtype: 'init', apiKeySource: mode === 'apikey' ? 'ANTHROPIC_API_KEY' : 'none', tools: ['Bash'], skills: [], plugins: [] });
if (mode === 'apikey' || mode === 'hang') { setTimeout(() => {}, 60_000); }
else {
	const seen = { args: process.argv.slice(2), cwd: process.cwd(), apiKey: 'ANTHROPIC_API_KEY' in process.env, ghConfigDir: process.env.GH_CONFIG_DIR, ghToken: process.env.GH_TOKEN ?? null };
	out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(seen), permission_denials: [] });
}
`;

let dir: string;
let claudeBin: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mreviewer-launch-'));
	claudeBin = join(dir, 'fake-claude');
	await writeFile(claudeBin, FAKE_CLAUDE);
	await chmod(claudeBin, 0o755);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const base = () => ({
	prompt: 'review',
	paths: instancePaths(join(dir, 'inst')),
	model: 'test-model',
	maxTurns: 3,
	timeoutMs: 10_000,
	claudeBin
});

describe('buildClaudeArgs', () => {
	it('isolates the run: restricted mode, our plugin, our settings, no --add-dir', () => {
		const args = buildClaudeArgs({
			prompt: 'p',
			agentDir: '/a',
			settingsPath: '/s.json',
			personaPath: '/p.md',
			model: 'm',
			maxTurns: 5,
			tools: ['Bash', 'Read']
		});
		expect(args).toEqual(
			expect.arrayContaining(['--restricted', '--strict-mcp-config', '--no-session-persistence'])
		);
		expect(args.join(' ')).toContain(
			'--plugin-dir /a --settings /s.json --permission-mode dontAsk --append-system-prompt-file /p.md'
		);
		expect(args.join(' ')).toContain('--tools Bash,Read');
		expect(args).not.toContain('--add-dir');
	});
});

describe('launchAgent', () => {
	it('runs in its own state/run dir with the cleaned environment and records the stream', async () => {
		const outcome = await launchAgent({
			...base(),
			runId: 'ok',
			token: 'reviewer-pat',
			env: { ...process.env, FAKE_MODE: 'ok', ANTHROPIC_API_KEY: 'sk-ant-x' }
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.refusedApiKey).toBe(false);
		const seen = JSON.parse(outcome.result?.text ?? '{}');
		expect(seen.cwd).toMatch(/\/inst\/state\/run\/ok$/);
		expect(seen.apiKey).toBe(false);
		expect(seen.ghToken).toBe('reviewer-pat');
		expect(seen.ghConfigDir).toBe(join(outcome.runDir, 'gh'));

		const settings = JSON.parse(await readFile(join(outcome.runDir, 'settings.json'), 'utf8'));
		expect(settings.sandbox.enabled).toBe(true);
		expect(await readFile(join(outcome.runDir, 'system-prompt.md'), 'utf8')).toContain(
			'Reviewer persona'
		);
		expect(
			(await readFile(join(outcome.runDir, 'stream.jsonl'), 'utf8')).trim().split('\n')
		).toHaveLength(2);
	});

	it('stops a run that starts on an API key instead of the subscription', async () => {
		const outcome = await launchAgent({
			...base(),
			runId: 'apikey',
			env: { ...process.env, FAKE_MODE: 'apikey' }
		});
		expect(outcome.refusedApiKey).toBe(true);
		expect(outcome.result).toBeUndefined();
	});

	it('kills a run that exceeds its timeout', async () => {
		const outcome = await launchAgent({
			...base(),
			runId: 'hang',
			timeoutMs: 300,
			env: { ...process.env, FAKE_MODE: 'hang' }
		});
		expect(outcome.timedOut).toBe(true);
		expect(outcome.result).toBeUndefined();
	});

	it('can be cancelled', async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 300);
		const outcome = await launchAgent({
			...base(),
			runId: 'cancel',
			signal: ac.signal,
			env: { ...process.env, FAKE_MODE: 'hang' }
		});
		expect(outcome.aborted).toBe(true);
	});
});

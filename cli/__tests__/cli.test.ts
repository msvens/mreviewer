import { describe, expect, it } from 'vitest';
import type { ReviewOptions, ReviewResult } from '@mreviewer/core';
import { ConfigError } from '@mreviewer/core';
import { run } from '../src/cli.ts';

const capture = () => {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

const result = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
	ref: 'a/b#1',
	draftPath: '/i/state/drafts/b-1-abc1234.md',
	draftExists: true,
	recordPath: '/i/state/logs/runs/r.json',
	worktreePath: '/i/state/worktrees/b-1-abc1234',
	model: 'claude-opus-5-5',
	checks: {
		ran: true,
		toolchain: 'pnpm',
		setup: [{ name: 'install', phase: 'install', command: 'pnpm install', status: 'passed' }],
		checks: [
			{ name: 'typecheck', phase: 'check', command: 'pnpm run typecheck', status: 'passed' },
			{ name: 'test', phase: 'check', command: 'pnpm run test', status: 'failed' }
		],
		dependencyDirs: [],
		restoredFiles: [],
		sandbox: { network: 'none', localhost: false }
	},
	outcome: {
		runId: 'r',
		runDir: '/i/state/run/r',
		exitCode: 0,
		timedOut: false,
		aborted: false,
		refusedApiKey: false,
		init: undefined,
		result: {
			subtype: 'success',
			isError: false,
			text: '',
			permissionDenials: [],
			numTurns: 12,
			durationMs: 95_000
		},
		stderr: ''
	},
	...overrides
});

describe('mreviewer CLI', () => {
	it('prints usage for help and fails without a command', async () => {
		const c = capture();
		expect(await run(['help'], c.io)).toBe(0);
		expect(c.out.join('\n')).toContain('review <owner/repo#N');
		expect(await run([], capture().io)).toBe(1);
	});

	it('passes the ref and flags to reviewPr and prints a summary', async () => {
		const c = capture();
		let call: [string, ReviewOptions] | undefined;
		const code = await run(['review', 'a/b#1', '--model', 'm', '--keep-worktree'], c.io, {
			reviewPr: async (ref, opts) => {
				call = [ref, opts];
				return result();
			}
		});
		expect(code).toBe(0);
		expect(call).toEqual(['a/b#1', { model: 'm', keepWorktree: true }]);
		expect(c.out.join('\n')).toContain('draft:   /i/state/drafts/b-1-abc1234.md');
		expect(c.out.join('\n')).toContain('duration: 95s');
		expect(c.out.join('\n')).toContain('checks:  1 passed, 1 failed');
	});

	it('exits non-zero and says why when no draft was written', async () => {
		const c = capture();
		const code = await run(['review', 'a/b#1'], c.io, {
			reviewPr: async () => result({ draftExists: false })
		});
		expect(code).toBe(2);
		expect(c.err.join('\n')).toContain('No draft was written');
	});

	it('shows known errors without a stack trace', async () => {
		const c = capture();
		const code = await run(['review', 'a/b#1'], c.io, {
			reviewPr: async () => {
				throw new ConfigError('a/b is not in config.yaml repos');
			}
		});
		expect(code).toBe(2);
		expect(c.err).toEqual(['a/b is not in config.yaml repos']);
	});

	it('rejects bad arguments', async () => {
		expect(await run(['review'], capture().io)).toBe(1);
		expect(await run(['review', 'a/b#1', 'extra'], capture().io)).toBe(1);
		expect(await run(['review', 'a/b#1', '--nope'], capture().io)).toBe(1);
		expect(await run(['frobnicate'], capture().io)).toBe(1);
	});
});

import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/cli.ts';
import type { PostOutcome, PreparedPost, ReviewOptions, ReviewResult } from '@mreviewer/core';
import { ConfigError, PostError } from '@mreviewer/core';
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
	post: { status: 'awaiting-approval', reason: 'auto_post is off for a/b' },
	...overrides
});

const noPost: Deps['postDraft'] = async () => {
	throw new Error('unexpected post');
};
const noReview: Deps['reviewPr'] = async () => {
	throw new Error('unexpected review');
};

const HEAD = 'a'.repeat(40);
const prepared = (): PreparedPost => ({
	draftPath: '/i/state/drafts/b-1-aaaaaaa.md',
	recordPath: '/i/state/drafts/b-1-aaaaaaa.posted.json',
	draft: {
		ref: { owner: 'a', repo: 'b', number: 1 },
		title: 'T',
		headSha: HEAD,
		findings: [],
		body: 'Head: …'
	},
	currentHeadSha: HEAD,
	review: {
		payload: {
			commit_id: HEAD,
			event: 'COMMENT',
			body: '[bot]\n\nHead: …\n',
			comments: [
				{
					path: 'src/x.ts',
					line: 9,
					start_line: 7,
					side: 'RIGHT',
					body: '[bot]\n\n**[nit] Tidy**\n\nx'
				}
			]
		},
		bodyOnly: []
	}
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
			},
			postDraft: noPost
		});
		expect(code).toBe(0);
		expect(call).toEqual(['a/b#1', { model: 'm', keepWorktree: true }]);
		expect(c.out.join('\n')).toContain('draft:   /i/state/drafts/b-1-abc1234.md');
		expect(c.out.join('\n')).toContain('duration: 95s');
		expect(c.out.join('\n')).toContain('checks:  1 passed, 1 failed');
		expect(c.out.join('\n')).toContain(
			'post:    awaiting approval (auto_post is off for a/b): mreviewer post a/b#1'
		);
	});

	it('exits non-zero and says why when no draft was written', async () => {
		const c = capture();
		const code = await run(['review', 'a/b#1'], c.io, {
			reviewPr: async () => result({ draftExists: false }),
			postDraft: noPost
		});
		expect(code).toBe(2);
		expect(c.err.join('\n')).toContain('No draft was written');
	});

	it('shows known errors without a stack trace', async () => {
		const c = capture();
		const code = await run(['review', 'a/b#1'], c.io, {
			reviewPr: async () => {
				throw new ConfigError('a/b is not in config.yaml repos');
			},
			postDraft: noPost
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

describe('mreviewer post', () => {
	const deps = (outcome: (opts: Parameters<Deps['postDraft']>[1]) => Promise<PostOutcome>) => {
		const calls: [string, Parameters<Deps['postDraft']>[1]][] = [];
		return {
			calls,
			deps: {
				reviewPr: noReview,
				postDraft: async (input: string, opts: Parameters<Deps['postDraft']>[1]) => {
					calls.push([input, opts]);
					return outcome(opts);
				}
			} satisfies Deps
		};
	};
	/** Behaves like postDraft: confirm decides, no confirm means preview. */
	const like = async (opts: Parameters<Deps['postDraft']>[1]): Promise<PostOutcome> => {
		const p = prepared();
		if (!opts.confirm) return { status: 'previewed', prepared: p };
		if (!(await opts.confirm(p))) return { status: 'declined', prepared: p };
		return {
			status: 'posted',
			prepared: p,
			record: {
				ref: 'a/b#1',
				reviewId: 1,
				url: 'https://github.com/a/b/pull/1#pullrequestreview-1',
				postedAt: '',
				headSha: HEAD,
				inline: 1,
				fileLevel: 0,
				bodyOnly: 0
			}
		};
	};

	it('previews with --dry-run and posts nothing', async () => {
		const c = capture();
		const d = deps(like);
		expect(await run(['post', 'a/b#1', '--dry-run'], c.io, d.deps)).toBe(0);
		expect(d.calls[0]?.[1].confirm).toBeUndefined();
		const out = c.out.join('\n');
		expect(out).toContain('a/b#1 (reviewed aaaaaaa) as a Comment review');
		expect(out).toContain('inline:    src/x.ts:7-9  [nit] Tidy');
		expect(out).toContain('--- review body ---\n[bot]');
	});

	it('asks before posting and stops on no', async () => {
		const asked: string[] = [];
		const c = capture();
		const io = {
			...c.io,
			ask: async (q: string) => {
				asked.push(q);
				return false;
			}
		};
		expect(await run(['post', 'a/b#1'], io, deps(like).deps)).toBe(3);
		expect(asked).toEqual(['Post this review?']);
		expect(c.err).toEqual(['Not posted.']);
	});

	it('posts on yes, and with --yes without asking', async () => {
		const c = capture();
		expect(await run(['post', 'a/b#1'], { ...c.io, ask: async () => true }, deps(like).deps)).toBe(
			0
		);
		expect(c.out.at(-1)).toBe('Posted: https://github.com/a/b/pull/1#pullrequestreview-1');
		const d = deps(like);
		expect(
			await run(['post', 'x.md', '--yes', '--force', '--allow-stale'], capture().io, d.deps)
		).toBe(0);
		expect(d.calls[0]?.[1]).toMatchObject({ force: true, allowStale: true });
	});

	it('refuses to post without a terminal unless --yes', async () => {
		const c = capture();
		const d = deps(like);
		expect(await run(['post', 'a/b#1'], c.io, d.deps)).toBe(1);
		expect(c.err[0]).toMatch(/pass --yes/);
		expect(d.calls).toEqual([]);
	});

	it('shows refusals without a stack trace', async () => {
		const c = capture();
		const d = deps(async () => {
			throw new PostError('b-1-aaaaaaa.md was already posted (url).');
		});
		expect(await run(['post', 'a/b#1', '--yes'], c.io, d.deps)).toBe(2);
		expect(c.err).toEqual(['b-1-aaaaaaa.md was already posted (url).']);
	});
});

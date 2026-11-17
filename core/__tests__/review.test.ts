import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHub, PrDetails, ReviewPayload } from '../src/github.ts';
import { instancePaths } from '../src/home.ts';
import type { SandboxExecutor } from '../src/checks/sandbox.ts';
import { acquireRunLock, LockBusyError } from '../src/lock.ts';
import { reviewPr } from '../src/review.ts';
import { createGitFixture, type GitFixture, sh } from './helpers/git-fixture.ts';

/** Fake `claude`: reads the prompt, records what it saw, writes the draft unless told not to. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const field = (name) => (prompt.match(new RegExp('^' + name + ': (.*)$', 'm')) || [])[1];
const wt = field('Worktree \\\\(PR head, read-only\\\\)');
const mode = process.env.FAKE_MODE;
out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [], skills: [], plugins: [] });
if (mode === 'fail') process.exit(1);
if (mode === 'gooddraft') fs.writeFileSync(field('Draft'), '# Review: o/local#1 — Add two\\n\\nHead: ' + field('Head sha') + ' · Base: main\\n\\n## Findings\\n\\n### [nit] Two\\nWhere: a.txt:2\\nProblem: p\\n');
else if (mode !== 'nodraft') fs.writeFileSync(field('Draft'), '# Review\\n' + JSON.stringify({ worktreeExisted: fs.existsSync(wt), prompt, hasToken: 'GH_TOKEN' in process.env, description: fs.readFileSync(field('PR description \\\\(read last\\\\)'), 'utf8'), issues: JSON.parse(fs.readFileSync(field('GitHub linked issues'), 'utf8')) }));
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 4, total_cost_usd: 0.01,
  permission_denials: mode === 'denial' ? [{ tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'git push' } }] : [] });
`;

let fx: GitFixture;
let claudeBin: string;
let paths: ReturnType<typeof instancePaths>;
const prDetails = (): PrDetails => ({
	number: 1,
	title: 'Add two',
	url: 'https://github.com/o/local/pull/1',
	state: 'MERGED',
	isDraft: false,
	author: 'someone',
	baseRef: 'main',
	baseSha: fx.mainAfterPr,
	headRef: 'feature',
	headSha: fx.headSha,
	labels: [],
	files: [{ path: 'a.txt', additions: 1, deletions: 0 }],
	commits: [{ oid: fx.headSha, headline: 'feature', body: '' }],
	closingIssues: [{ owner: 'o', repo: 'local', number: 7 }],
	body: 'Adds line two.',
	comments: [],
	reviews: [],
	checks: []
});
let posted: ReviewPayload[] = [];
const github: GitHub = {
	pr: async () => prDetails(),
	prFiles: async () => [{ path: 'a.txt', status: 'modified', patch: '@@ -1 +1,2 @@\n one\n+two' }],
	postReview: async (_ref, review) => {
		posted.push(review);
		return { id: 9, url: 'https://github.com/o/local/pull/1#pullrequestreview-9' };
	},
	issue: async (ref) => ({
		...ref,
		title: 'Need two',
		body: 'Please add two',
		state: 'CLOSED',
		url: ''
	})
};

beforeEach(async () => {
	posted = [];
	fx = await createGitFixture();
	claudeBin = join(fx.root, 'fake-claude.cjs');
	await writeFile(claudeBin, FAKE_CLAUDE);
	await chmod(claudeBin, 0o755);
	paths = instancePaths(join(fx.root, 'inst'));
	await mkdir(paths.config.root, { recursive: true });
	await writeFile(
		paths.config.configYaml,
		`projects_root: ${fx.root}\nreview:\n  model: test-model\n  max_nits: 2\nrepos:\n  - name: o/local\n    path: local\n    stack: ts\n`
	);
});
afterEach(() => rm(fx.root, { recursive: true, force: true }));

const run = (mode: string, extra: object = {}) =>
	reviewPr('o/local#1', {
		paths,
		github,
		token: 'tok',
		claudeBin,
		env: { ...process.env, FAKE_MODE: mode },
		...extra
	});

describe('reviewPr', () => {
	it('runs the agent on a prepared worktree and writes the draft, then cleans up', async () => {
		const refs = sh(fx.local, 'for-each-ref');
		const r = await run('draft');

		expect(r.draftPath).toBe(join(paths.state.drafts, `local-1-${fx.headSha.slice(0, 7)}.md`));
		expect(r.draftExists).toBe(true);
		const seen = JSON.parse((await readFile(r.draftPath, 'utf8')).split('\n')[1] ?? '{}');
		expect(seen.worktreeExisted).toBe(true);
		expect(seen.prompt).toMatch(/^\/mreviewer:review-pr o\/local#1$/m);
		expect(seen.prompt).toContain(`Base: main (merge-base ${fx.baseSha})`);
		expect(seen.prompt).toContain('Max nits: 2');
		expect(seen.prompt).toContain('Model: test-model');
		expect(seen.prompt).toMatch(/^Check results: .*\/checks\/checks\.json$/m);
		expect(r.checks).toMatchObject({
			ran: false,
			reason: expect.stringMatching(/run_checks is off/)
		});
		// The agent has no GitHub token; it reads what core prefetched.
		expect(seen.hasToken).toBe(false);
		expect(seen.description).toBe('Adds line two.\n');
		expect(seen.issues).toEqual([
			{
				owner: 'o',
				repo: 'local',
				number: 7,
				title: 'Need two',
				body: 'Please add two',
				state: 'CLOSED',
				url: ''
			}
		]);

		expect(existsSync(r.worktreePath)).toBe(false);
		expect(existsSync(paths.state.runLock)).toBe(false);
		expect(sh(fx.local, 'for-each-ref')).toBe(refs);

		const record = JSON.parse(await readFile(r.recordPath, 'utf8'));
		expect(record).toMatchObject({
			ref: 'o/local#1',
			model: 'test-model',
			draftExists: true,
			numTurns: 4,
			apiKeySource: 'none'
		});
	});

	it('runs the checks on the PR head before the agent when the repo opts in', async () => {
		await writeFile(
			paths.config.configYaml,
			`projects_root: ${fx.root}\nrepos:\n  - name: o/local\n    path: local\n    stack: ts\n    run_checks: true\n    trusted_authors: [someone]\n    toolchain: pnpm\n    checks:\n      - name: test\n        run: pnpm run test\n`
		);
		const seenCwd: string[] = [];
		const sandbox = async (): Promise<SandboxExecutor> => ({
			exec: async (req) => {
				seenCwd.push(req.cwd);
				return { exitCode: 0, timedOut: false, durationMs: 1, tail: '' };
			},
			dispose: async () => undefined
		});
		const r = await run('draft', { checkSandbox: sandbox });
		expect(seenCwd).toEqual([r.worktreePath, r.worktreePath]);
		expect(r.checks.checks).toMatchObject([{ name: 'test', status: 'passed' }]);
		const record = JSON.parse(await readFile(r.recordPath, 'utf8'));
		expect(record).toMatchObject({
			checks: '1 passed',
			checkStatuses: { install: 'passed', test: 'passed' }
		});
		expect(existsSync(r.worktreePath)).toBe(false);
	});

	it('leaves the draft for approval by default', async () => {
		const r = await run('gooddraft');
		expect(r.post).toEqual({ status: 'awaiting-approval', reason: 'auto_post is off for o/local' });
		expect(posted).toEqual([]);
	});

	describe('with auto_post', () => {
		const autoConfig = (authors = 'someone') =>
			writeFile(
				paths.config.configYaml,
				`projects_root: ${fx.root}\nrepos:\n  - name: o/local\n    path: local\n    stack: ts\n    auto_post: true\n    trusted_authors: [${authors}]\n`
			);

		it('posts a clean run on the reviewed head and records it', async () => {
			await autoConfig();
			const r = await run('gooddraft');
			expect(r.post).toEqual({
				status: 'posted',
				url: 'https://github.com/o/local/pull/1#pullrequestreview-9'
			});
			expect(posted[0]).toMatchObject({
				commit_id: fx.headSha,
				event: 'COMMENT',
				comments: [{ path: 'a.txt', line: 2, side: 'RIGHT' }]
			});
			expect(existsSync(r.draftPath.replace(/\.md$/, '.posted.json'))).toBe(true);
			expect(JSON.parse(await readFile(r.recordPath, 'utf8')).post.status).toBe('posted');
			// Same head again: the draft is already posted, so nothing is sent twice.
			const again = await run('gooddraft');
			expect(again.post).toMatchObject({
				status: 'failed',
				error: expect.stringMatching(/already posted/)
			});
			expect(posted).toHaveLength(1);
		});

		it('waits for approval when the author is not trusted', async () => {
			await autoConfig('alice');
			expect((await run('gooddraft')).post).toMatchObject({ status: 'awaiting-approval' });
			expect(posted).toEqual([]);
		});

		it('does not post a failed run, and records a failed post without failing the review', async () => {
			await autoConfig();
			expect((await run('fail')).post.status).toBe('not-posted');
			const r = await run('draft');
			expect(r.post).toMatchObject({
				status: 'failed',
				error: expect.stringMatching(/title line/)
			});
			expect(r.draftExists).toBe(true);
			expect(posted).toEqual([]);
		});
	});

	it('logs permission denials to state/logs/denied.jsonl', async () => {
		const r = await run('denial');
		const line = JSON.parse(
			(await readFile(join(paths.state.logs, 'denied.jsonl'), 'utf8')).trim()
		);
		expect(line).toMatchObject({
			runId: r.outcome.runId,
			ref: 'o/local#1',
			tool: 'Bash',
			input: { command: 'git push' }
		});
	});

	it('still removes the worktree and releases the lock when the agent fails', async () => {
		const r = await run('fail');
		expect(r.outcome.exitCode).toBe(1);
		expect(r.draftExists).toBe(false);
		expect(existsSync(r.worktreePath)).toBe(false);
		expect(existsSync(paths.state.runLock)).toBe(false);
	});

	it('keeps the worktree when asked', async () => {
		const r = await run('draft', { keepWorktree: true });
		expect(existsSync(r.worktreePath)).toBe(true);
		sh(fx.local, 'worktree', 'remove', '--force', r.worktreePath);
	});

	it('honours a model override', async () => {
		expect((await run('draft', { model: 'other-model' })).model).toBe('other-model');
	});

	it('refuses to run while another review holds the lock', async () => {
		await mkdir(paths.state.root, { recursive: true });
		const release = await acquireRunLock(paths.state.runLock, 'other');
		await expect(run('draft')).rejects.toBeInstanceOf(LockBusyError);
		await release();
	});

	it('releases the lock when the PR cannot be checked out', async () => {
		const moved: GitHub = {
			...github,
			pr: async () => ({ ...prDetails(), headSha: fx.baseSha })
		};
		await expect(run('draft', { github: moved })).rejects.toThrow(/head moved/);
		expect(existsSync(paths.state.runLock)).toBe(false);
	});
});

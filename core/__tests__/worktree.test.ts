import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instancePaths } from '../src/home.ts';
import { preparePrWorktree, removePrWorktree } from '../src/worktree.ts';
import { createGitFixture, type GitFixture, sh } from './helpers/git-fixture.ts';

let fx: GitFixture;
beforeEach(async () => {
	fx = await createGitFixture();
});
afterEach(() => rm(fx.root, { recursive: true, force: true }));

const input = () => ({
	repoDir: fx.local,
	repoSlug: 'local',
	number: 1,
	baseRef: 'main',
	expectedHeadSha: fx.headSha,
	paths: instancePaths(join(fx.root, 'inst'))
});

describe('preparePrWorktree', () => {
	it('checks out the PR head detached under state/worktrees and finds the merge-base', async () => {
		const wt = await preparePrWorktree(input());
		expect(wt.path).toBe(
			join(fx.root, 'inst', 'state', 'worktrees', `local-1-${fx.headSha.slice(0, 7)}`)
		);
		expect(sh(wt.path, 'rev-parse', 'HEAD')).toBe(fx.headSha);
		expect(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
		expect(wt.baseSha).toBe(fx.mainAfterPr);
		expect(wt.mergeBase).toBe(fx.baseSha);
		expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
		await removePrWorktree(wt);
	});

	it('creates no branches or refs, and removal leaves the repo as it was', async () => {
		const refs = sh(fx.local, 'for-each-ref');
		const wt = await preparePrWorktree(input());
		expect(sh(fx.local, 'for-each-ref')).toBe(refs);
		await removePrWorktree(wt);
		expect(existsSync(wt.path)).toBe(false);
		expect(sh(fx.local, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
		expect(sh(fx.local, 'for-each-ref')).toBe(refs);
	});

	it('refuses when the fetched head is not the head GitHub reported', async () => {
		await expect(preparePrWorktree({ ...input(), expectedHeadSha: fx.baseSha })).rejects.toThrow(
			/head moved/
		);
		expect(sh(fx.local, 'worktree', 'list')).not.toContain('worktrees');
	});

	it('fails cleanly for a PR that does not exist', async () => {
		await expect(preparePrWorktree({ ...input(), number: 99 })).rejects.toThrow(/pull\/99\/head/);
	});
});

describe('removePrWorktree', () => {
	it('fails loudly if a ref appeared during the review', async () => {
		const wt = await preparePrWorktree(input());
		sh(fx.local, 'branch', 'sneaky', fx.headSha);
		await expect(removePrWorktree(wt)).rejects.toThrow(/refs in .* changed/);
		expect(existsSync(wt.path)).toBe(false);
	});
});

describe('diff base for merged PRs', () => {
	it('uses the PR base commit when the base branch already contains the head (merge commit)', async () => {
		// Merge the PR into main on origin, the way GitHub does with a merge commit.
		const author = join(fx.root, 'author');
		sh(author, 'switch', '-q', 'main');
		sh(author, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', fx.headSha);
		sh(author, 'push', '-q', fx.origin, 'main');

		const wt = await preparePrWorktree({
			...input(),
			baseSha: fx.mainAfterPr,
			firstCommitSha: fx.headSha
		});
		expect(wt.mergeBase).toBe(fx.baseSha);
		expect(sh(wt.path, 'diff', '--stat', `${wt.mergeBase}...HEAD`)).toContain('a.txt');
		await removePrWorktree(wt);
	});

	it("falls back to the first commit's parent when the PR was fast-forwarded", async () => {
		const author = join(fx.root, 'author');
		sh(author, 'push', '-q', '--force', fx.origin, `${fx.headSha}:refs/heads/main`);

		const wt = await preparePrWorktree({
			...input(),
			baseSha: fx.headSha,
			firstCommitSha: fx.headSha
		});
		expect(wt.mergeBase).toBe(fx.baseSha);
		await removePrWorktree(wt);
	});

	it('refuses when no diff base can be found', async () => {
		const author = join(fx.root, 'author');
		sh(author, 'push', '-q', '--force', fx.origin, `${fx.headSha}:refs/heads/main`);
		await expect(preparePrWorktree({ ...input(), baseSha: fx.headSha })).rejects.toThrow(
			/cannot find a diff base/
		);
	});
});

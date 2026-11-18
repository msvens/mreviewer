import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.ts';
import type { InstancePaths } from './home.ts';

/** GitHub's PR head and the fetched head differ, usually because GitHub's API lags a push. */
export class HeadMovedError extends Error {
	constructor(number: number, expected: string, fetched: string) {
		super(
			`PR #${number} head moved: GitHub says ${expected.slice(0, 7)}, fetched ${fetched.slice(0, 7)}. Try again in a moment.`
		);
		this.name = 'HeadMovedError';
	}
}

export interface PrWorktree {
	/** The user's local checkout the worktree belongs to. */
	repoDir: string;
	/** Detached worktree of the PR head under state/worktrees/. */
	path: string;
	headSha: string;
	baseSha: string;
	/** Where the PR branched from the base: diff against this. */
	mergeBase: string;
	/** `git for-each-ref` before checkout; compared again on removal. */
	refsBefore: string;
}

export interface PrepareInput {
	repoDir: string;
	/** Short repo name used in the worktree directory name. */
	repoSlug: string;
	number: number;
	baseRef: string;
	/** GitHub's base commit for the PR; preferred over the current base tip when present locally. */
	baseSha?: string;
	/** The PR's first commit; its parent is the fallback diff base when the base already contains the head. */
	firstCommitSha?: string;
	/** The PR's head sha according to GitHub; refuse if the fetched head differs. */
	expectedHeadSha: string;
	paths: InstancePaths;
}

const hasCommit = (repoDir: string, sha: string) =>
	git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]).then(
		() => true,
		() => false
	);

const listRefs = (repoDir: string) =>
	git(repoDir, ['for-each-ref', '--format=%(refname) %(objectname)']);

/**
 * Check out a PR head as a detached worktree under state/worktrees/. Fetches go to FETCH_HEAD only, so
 * no branches or refs are created in the user's repo. Runs in core, never in the agent: fetches and
 * worktree metadata write into the repo's .git, which the agent's sandbox keeps read-only.
 */
export async function preparePrWorktree(input: PrepareInput): Promise<PrWorktree> {
	const { repoDir, number } = input;
	const refsBefore = await listRefs(repoDir);

	// --refmap= (empty) stops git from also updating remote-tracking refs such as origin/main.
	await git(repoDir, [
		'fetch',
		'--no-tags',
		'--quiet',
		'--refmap=',
		'origin',
		`refs/heads/${input.baseRef}`
	]);
	const baseTip = await git(repoDir, ['rev-parse', 'FETCH_HEAD']);
	await git(repoDir, [
		'fetch',
		'--no-tags',
		'--quiet',
		'--refmap=',
		'origin',
		`pull/${number}/head`
	]);
	const headSha = await git(repoDir, ['rev-parse', 'FETCH_HEAD']);
	if (headSha !== input.expectedHeadSha) {
		throw new HeadMovedError(number, input.expectedHeadSha, headSha);
	}

	// For a merged PR the base branch tip already contains the head, which would make the
	// merge-base the head itself and the diff empty. GitHub's base commit for the PR avoids that.
	const baseSha =
		input.baseSha && (await hasCommit(repoDir, input.baseSha)) ? input.baseSha : baseTip;
	let mergeBase = await git(repoDir, ['merge-base', baseSha, headSha]);
	if (mergeBase === headSha && input.firstCommitSha) {
		// Fast-forwarded into the base: diff from where the PR's first commit started.
		mergeBase = await git(repoDir, ['rev-parse', `${input.firstCommitSha}^`]);
	}
	if (mergeBase === headSha) {
		throw new Error(`PR #${number}: cannot find a diff base (the base already contains the head)`);
	}

	await mkdir(input.paths.state.worktrees, { recursive: true });
	const path = join(
		input.paths.state.worktrees,
		`${input.repoSlug}-${number}-${headSha.slice(0, 7)}`
	);
	await git(repoDir, ['worktree', 'add', '--detach', '--quiet', path, headSha]);
	return { repoDir, path, headSha, baseSha, mergeBase, refsBefore };
}

/**
 * Remove the worktree and verify the user's refs are exactly as before. Throws if refs changed,
 * so a leak is loud rather than silent.
 */
export async function removePrWorktree(wt: PrWorktree): Promise<void> {
	await git(wt.repoDir, ['worktree', 'remove', '--force', wt.path]).catch(() => undefined);
	await git(wt.repoDir, ['worktree', 'prune']);
	const listed = await git(wt.repoDir, ['worktree', 'list', '--porcelain']);
	if (listed.split('\n').some((l) => l === `worktree ${wt.path}`)) {
		throw new Error(`worktree ${wt.path} is still registered in ${wt.repoDir}`);
	}
	const refsAfter = await listRefs(wt.repoDir);
	if (refsAfter !== wt.refsBefore) {
		throw new Error(
			`refs in ${wt.repoDir} changed during the review:\nbefore:\n${wt.refsBefore}\nafter:\n${refsAfter}`
		);
	}
}

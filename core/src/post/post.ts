import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { readToken } from '../agent/token.ts';
import { loadConfig } from '../config.ts';
import { type GitHub, ghGitHub } from '../github.ts';
import { type InstancePaths, instancePaths, resolveHome } from '../home.ts';
import { acquireRunLock } from '../lock.ts';
import { formatPrRef, PrRefError, parsePrRef } from '../pr-ref.ts';
import { type BuiltReview, buildReview } from './build.ts';
import { type Draft, parseDraft } from './draft.ts';

export class PostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PostError';
	}
}

export interface PostOptions {
	paths?: InstancePaths;
	/** Post even though this draft was posted before. */
	force?: boolean;
	/** Post although the PR head moved since the review; anchors stay on the reviewed commit. */
	allowStale?: boolean;
	/** Test seams. */
	github?: GitHub;
	token?: string;
}

export interface PreparedPost {
	draftPath: string;
	/** Where the post record goes: <draft>.posted.json. */
	recordPath: string;
	draft: Draft;
	/** The PR's head now; differs from draft.headSha only with allowStale. */
	currentHeadSha: string;
	review: BuiltReview;
}

export interface PostRecord {
	ref: string;
	reviewId: number;
	url: string;
	postedAt: string;
	headSha: string;
	inline: number;
	fileLevel: number;
	bodyOnly: number;
}

const recordPathFor = (draftPath: string) => draftPath.replace(/\.md$/, '.posted.json');

/**
 * A draft path, or `owner/repo#N` / a PR URL for that PR's newest draft in state/drafts/
 * (`<repo>-<N>-<sha7>.md`).
 */
export async function resolveDraft(input: string, paths: InstancePaths): Promise<string> {
	if (input.endsWith('.md')) {
		for (const p of [resolve(input), join(paths.state.drafts, input)]) if (existsSync(p)) return p;
		throw new PostError(`No draft at ${input}`);
	}
	let ref;
	try {
		ref = parsePrRef(input);
	} catch {
		throw new PrRefError(input);
	}
	const pattern = new RegExp(`^${ref.repo.replace(/[.]/g, '\\.')}-${ref.number}-[0-9a-f]{7}\\.md$`);
	const names = existsSync(paths.state.drafts)
		? (await readdir(paths.state.drafts)).filter((n) => pattern.test(n))
		: [];
	const dated = await Promise.all(
		names.map(async (n) => {
			const p = join(paths.state.drafts, n);
			return { p, mtime: (await stat(p)).mtimeMs };
		})
	);
	const newest = dated.sort((a, b) => b.mtime - a.mtime)[0];
	if (!newest) throw new PostError(`No draft for ${formatPrRef(ref)} in ${paths.state.drafts}`);
	return newest.p;
}

/**
 * Parse the draft and build the review, without posting. Refuses a draft that was posted before
 * (unless `force`) and a PR whose head moved since the review (unless `allowStale`).
 */
export async function preparePost(
	draftPath: string,
	github: GitHub,
	prefix: string,
	opts: Pick<PostOptions, 'force' | 'allowStale'> = {}
): Promise<PreparedPost> {
	const draft = parseDraft(await readFile(draftPath, 'utf8'), basename(draftPath));
	const recordPath = recordPathFor(draftPath);
	if (existsSync(recordPath) && !opts.force) {
		const prior = JSON.parse(await readFile(recordPath, 'utf8')) as Partial<PostRecord>;
		throw new PostError(
			`${basename(draftPath)} was already posted (${prior.url ?? recordPath}). Use --force to post it again.`
		);
	}
	const pr = await github.pr(draft.ref);
	if (pr.headSha !== draft.headSha && !opts.allowStale) {
		throw new PostError(
			`${formatPrRef(draft.ref)} has new commits: the draft reviewed ${draft.headSha.slice(0, 7)}, the PR head is now ${pr.headSha.slice(0, 7)}. Review again, or use --allow-stale to post on the reviewed commit.`
		);
	}
	const files = await github.prFiles(draft.ref);
	return {
		draftPath,
		recordPath,
		draft,
		currentHeadSha: pr.headSha,
		review: buildReview(draft, files, prefix)
	};
}

/** Post a prepared review and record it next to the draft. */
export async function sendPost(p: PreparedPost, github: GitHub): Promise<PostRecord> {
	const posted = await github.postReview(p.draft.ref, p.review.payload);
	const comments = p.review.payload.comments;
	const record: PostRecord = {
		ref: formatPrRef(p.draft.ref),
		reviewId: posted.id,
		url: posted.url,
		postedAt: new Date().toISOString(),
		headSha: p.draft.headSha,
		inline: comments.filter((c) => 'line' in c).length,
		fileLevel: comments.filter((c) => !('line' in c)).length,
		bodyOnly: p.review.bodyOnly.length
	};
	await writeFile(p.recordPath, `${JSON.stringify(record, null, '\t')}\n`);
	return record;
}

export type PostOutcome =
	| { status: 'posted'; prepared: PreparedPost; record: PostRecord }
	| { status: 'previewed'; prepared: PreparedPost }
	| { status: 'declined'; prepared: PreparedPost };

/**
 * `mreviewer post`: resolve and prepare the draft, let `confirm` see the review (preview and
 * approval), then post it under the run lock. Without `confirm`, only prepares (dry run).
 */
export async function postDraft(
	input: string,
	opts: PostOptions & { confirm?: (p: PreparedPost) => Promise<boolean> } = {}
): Promise<PostOutcome> {
	const paths = opts.paths ?? instancePaths(resolveHome());
	const config = await loadConfig(paths);
	const draftPath = await resolveDraft(input, paths);
	const github = opts.github ?? ghGitHub(opts.token ?? (await readToken()));
	const prepared = await preparePost(draftPath, github, config.review.post_prefix, opts);
	if (!opts.confirm) return { status: 'previewed', prepared };
	if (!(await opts.confirm(prepared))) return { status: 'declined', prepared };

	const release = await acquireRunLock(
		paths.state.runLock,
		`post ${formatPrRef(prepared.draft.ref)}`
	);
	try {
		// Another process may have posted it while we waited for the answer.
		if (existsSync(prepared.recordPath) && !opts.force) {
			throw new PostError(`${basename(draftPath)} was posted in the meantime.`);
		}
		return { status: 'posted', prepared, record: await sendPost(prepared, github) };
	} finally {
		await release();
	}
}

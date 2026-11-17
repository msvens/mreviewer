import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrRef } from './pr-ref.ts';

const execFileAsync = promisify(execFile);

export interface PrFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface PrCommit {
	oid: string;
	headline: string;
	body: string;
}

export interface IssueRef {
	owner: string;
	repo: string;
	number: number;
}

export interface Comment {
	author: string;
	body: string;
	createdAt: string;
}

export interface Review extends Comment {
	state: string;
}

export interface Check {
	name: string;
	status: string;
	conclusion: string;
}

/** Everything core fetches about a PR before a run. The agent itself has no GitHub access. */
export interface PrDetails {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	author: string;
	baseRef: string;
	/** GitHub's base commit for the PR (for a merged PR: the base as it was when merged). */
	baseSha: string;
	headRef: string;
	headSha: string;
	labels: string[];
	files: PrFile[];
	commits: PrCommit[];
	closingIssues: IssueRef[];
	/** The PR description. Kept apart: the reviewer reads it last. */
	body: string;
	comments: Comment[];
	reviews: Review[];
	checks: Check[];
}

export interface IssueDetails extends IssueRef {
	title: string;
	body: string;
	state: string;
	url: string;
}

/** A changed file with its diff, from the pulls files API. */
export interface PrFileDiff {
	path: string;
	status: string;
	/** Unified diff hunks; missing for binary or very large files. */
	patch?: string;
}

/** A review comment anchored to lines on the PR head side, or to a whole file. */
export type ReviewComment =
	| { path: string; line: number; start_line?: number; side: 'RIGHT'; body: string }
	| { path: string; subject_type: 'file'; body: string };

export interface ReviewPayload {
	/** The commit the review is about: the head the draft was written for. */
	commit_id: string;
	event: 'COMMENT';
	body: string;
	comments: ReviewComment[];
}

export interface PostedReview {
	id: number;
	url: string;
}

/** What core needs from GitHub. Injectable so tests can stub it. */
export interface GitHub {
	pr(ref: PrRef): Promise<PrDetails>;
	issue(ref: IssueRef): Promise<IssueDetails>;
	prFiles(ref: PrRef): Promise<PrFileDiff[]>;
	postReview(ref: PrRef, review: ReviewPayload): Promise<PostedReview>;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const login = (v: unknown) => str((v as Json | undefined)?.login);

const PR_FIELDS = [
	'number',
	'title',
	'url',
	'state',
	'isDraft',
	'author',
	'baseRefName',
	'baseRefOid',
	'headRefName',
	'headRefOid',
	'labels',
	'files',
	'commits',
	'closingIssuesReferences',
	'body',
	'comments',
	'reviews',
	'statusCheckRollup'
].join(',');

/** Map `gh pr view --json` output to PrDetails. Exported for tests. */
export function toPrDetails(pr: Json, ref: PrRef): PrDetails {
	return {
		number: num(pr.number),
		title: str(pr.title),
		url: str(pr.url),
		state: str(pr.state),
		isDraft: pr.isDraft === true,
		author: login(pr.author),
		baseRef: str(pr.baseRefName),
		baseSha: str(pr.baseRefOid),
		headRef: str(pr.headRefName),
		headSha: str(pr.headRefOid),
		labels: arr(pr.labels).map((l) => str(l.name)),
		files: arr(pr.files).map((f) => ({
			path: str(f.path),
			additions: num(f.additions),
			deletions: num(f.deletions)
		})),
		commits: arr(pr.commits).map((c) => ({
			oid: str(c.oid),
			headline: str(c.messageHeadline),
			body: str(c.messageBody)
		})),
		closingIssues: arr(pr.closingIssuesReferences).map((i) => {
			const repo = (i.repository ?? {}) as Json;
			return {
				owner: login(repo.owner) || ref.owner,
				repo: str(repo.name) || ref.repo,
				number: num(i.number)
			};
		}),
		body: str(pr.body),
		comments: arr(pr.comments).map((c) => ({
			author: login(c.author),
			body: str(c.body),
			createdAt: str(c.createdAt)
		})),
		reviews: arr(pr.reviews).map((r) => ({
			author: login(r.author),
			body: str(r.body),
			createdAt: str(r.submittedAt),
			state: str(r.state)
		})),
		checks: arr(pr.statusCheckRollup).map((c) => ({
			name: str(c.name) || str(c.context),
			status: str(c.status) || str(c.state),
			conclusion: str(c.conclusion)
		}))
	};
}

/** Map pulls files API entries to PrFileDiff. Exported for tests. */
export function toPrFiles(files: Json[]): PrFileDiff[] {
	return files.map((f) => ({
		path: str(f.filename),
		status: str(f.status),
		...(typeof f.patch === 'string' && { patch: f.patch })
	}));
}

/** GitHub via the `gh` CLI, run by core (outside the sandbox) with the reviewer token. */
export function ghGitHub(token: string): GitHub {
	const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' };
	delete env.GITHUB_TOKEN;
	const gh = async (args: string[]) =>
		JSON.parse(
			(await execFileAsync('gh', args, { env, maxBuffer: 64 * 1024 * 1024 })).stdout
		) as unknown;
	/** gh with a JSON request body on stdin. */
	const ghInput = (args: string[], input: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			const child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
			let out = '';
			let err = '';
			child.stdout.on('data', (d: Buffer) => (out += d.toString()));
			child.stderr.on('data', (d: Buffer) => (err += d.toString()));
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve(JSON.parse(out));
				else reject(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(err || out).trim()}`));
			});
			child.stdin.end(JSON.stringify(input));
		});
	const repoPath = (ref: PrRef) => `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
	return {
		async pr(ref) {
			const pr = (await gh([
				'pr',
				'view',
				String(ref.number),
				'-R',
				`${ref.owner}/${ref.repo}`,
				'--json',
				PR_FIELDS
			])) as Json;
			return toPrDetails(pr, ref);
		},
		async issue(ref) {
			const i = (await gh([
				'issue',
				'view',
				String(ref.number),
				'-R',
				`${ref.owner}/${ref.repo}`,
				'--json',
				'title,body,state,url'
			])) as Json;
			return {
				...ref,
				title: str(i.title),
				body: str(i.body),
				state: str(i.state),
				url: str(i.url)
			};
		},
		async prFiles(ref) {
			const pages = (await gh([
				'api',
				'--paginate',
				'--slurp',
				`${repoPath(ref)}/files?per_page=100`
			])) as unknown[];
			return toPrFiles(pages.flatMap((p) => arr(p)));
		},
		async postReview(ref, review) {
			const r = (await ghInput(
				['api', '-X', 'POST', `${repoPath(ref)}/reviews`, '--input', '-'],
				review
			)) as Json;
			return { id: num(r.id), url: str(r.html_url) };
		}
	};
}

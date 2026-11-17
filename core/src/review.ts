import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchAgent, type RunOutcome } from './agent/launch.ts';
import { readToken } from './agent/token.ts';
import type { Executor } from './checks/exec.ts';
import { type ChecksSummary, describeChecks, runChecks } from './checks/run.ts';
import type { SandboxExecutor } from './checks/sandbox.ts';
import { findRepo, loadConfig } from './config.ts';
import { type GitHub, ghGitHub, type PrDetails } from './github.ts';
import { type InstancePaths, instancePaths, resolveHome } from './home.ts';
import { acquireRunLock } from './lock.ts';
import { formatPrRef, type PrRef, parsePrRef, repoName } from './pr-ref.ts';
import { type GitHubContext, writeGitHubContext } from './prefetch.ts';
import { type PrWorktree, preparePrWorktree, removePrWorktree } from './worktree.ts';

export interface ReviewOptions {
	paths?: InstancePaths;
	/** Overrides review.model from config.yaml. */
	model?: string;
	/** Leave the worktree in place after the run (for debugging). */
	keepWorktree?: boolean;
	/** Test seams. */
	github?: GitHub;
	token?: string;
	claudeBin?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	checkSandbox?: () => Promise<SandboxExecutor>;
	checkHostExec?: Executor;
}

export interface ReviewResult {
	ref: string;
	draftPath: string;
	draftExists: boolean;
	recordPath: string;
	worktreePath: string;
	model: string;
	checks: ChecksSummary;
	outcome: RunOutcome;
}

export interface PromptInput {
	ref: PrRef;
	pr: PrDetails;
	wt: PrWorktree;
	gh: GitHubContext;
	checksPath: string;
	draftPath: string;
	maxNits: number;
	model: string;
}

/** The agent's prompt: invoke the skill and hand it everything core prepared. */
export function buildReviewPrompt({
	ref,
	pr,
	wt,
	gh,
	checksPath,
	draftPath,
	maxNits,
	model
}: PromptInput): string {
	return [
		`/mreviewer:review-pr ${formatPrRef(ref)}`,
		'',
		`PR: ${pr.url}`,
		`Worktree (PR head, read-only): ${wt.path}`,
		`Head sha: ${wt.headSha}`,
		`Base: ${pr.baseRef} (merge-base ${wt.mergeBase})`,
		`GitHub PR data: ${gh.pr}`,
		`GitHub linked issues: ${gh.issues}`,
		`GitHub discussion: ${gh.discussion}`,
		`GitHub checks: ${gh.checks}`,
		`PR description (read last): ${gh.description}`,
		`Check results: ${checksPath}`,
		`Draft: ${draftPath}`,
		`Notes: ${draftPath.replace(/\.md$/, '.notes.md')}`,
		`Max nits: ${maxNits}`,
		`Model: ${model}`
	].join('\n');
}

async function logRun(
	paths: InstancePaths,
	ref: string,
	result: Omit<ReviewResult, 'recordPath'>
): Promise<string> {
	const runsDir = join(paths.state.logs, 'runs');
	await mkdir(runsDir, { recursive: true });
	const { outcome } = result;
	const recordPath = join(runsDir, `${outcome.runId}.json`);
	const record = {
		ref,
		runId: outcome.runId,
		model: result.model,
		draftPath: result.draftPath,
		draftExists: result.draftExists,
		exitCode: outcome.exitCode,
		timedOut: outcome.timedOut,
		aborted: outcome.aborted,
		refusedApiKey: outcome.refusedApiKey,
		apiKeySource: outcome.init?.apiKeySource,
		subtype: outcome.result?.subtype,
		isError: outcome.result?.isError,
		numTurns: outcome.result?.numTurns,
		durationMs: outcome.result?.durationMs,
		costUsd: outcome.result?.costUsd,
		permissionDenials: outcome.result?.permissionDenials.length ?? 0,
		checks: describeChecks(result.checks),
		checkStatuses: Object.fromEntries(
			[...result.checks.setup, ...result.checks.checks].map((c) => [c.name, c.status])
		)
	};
	await writeFile(recordPath, `${JSON.stringify(record, null, '\t')}\n`);

	// Raw material for tool proposals (phase 4): every refused call, one JSON line each.
	const denials = outcome.result?.permissionDenials ?? [];
	if (denials.length > 0) {
		const time = new Date().toISOString();
		const lines = denials.map((d) =>
			JSON.stringify({ time, runId: outcome.runId, ref, tool: d.tool_name, input: d.tool_input })
		);
		await appendFile(join(paths.state.logs, 'denied.jsonl'), `${lines.join('\n')}\n`);
	}
	return recordPath;
}

/**
 * Review one PR end to end: lock, fetch the PR's GitHub data, check out the PR head as a detached
 * worktree, run the repo's checks on it in the sandbox (if allowed), run the agent's review-pr
 * skill, remove the worktree, log the run. The draft lands in state/drafts/.
 *
 * All GitHub access happens here, in core, with the reviewer token. The agent gets no token: `gh`
 * cannot verify TLS inside the macOS sandbox anyway, and a token-less agent can only write drafts.
 */
export async function reviewPr(input: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
	const paths = opts.paths ?? instancePaths(resolveHome());
	const ref = parsePrRef(input);
	const label = formatPrRef(ref);
	const config = await loadConfig(paths);
	const repo = findRepo(config, repoName(ref));
	const model = opts.model ?? config.review.model;

	await mkdir(paths.state.root, { recursive: true });
	const release = await acquireRunLock(paths.state.runLock, label);
	try {
		const github = opts.github ?? ghGitHub(opts.token ?? (await readToken()));
		const pr = await github.pr(ref);
		const wt = await preparePrWorktree({
			repoDir: repo.dir,
			repoSlug: ref.repo,
			number: ref.number,
			baseRef: pr.baseRef,
			baseSha: pr.baseSha,
			...(pr.commits[0] && { firstCommitSha: pr.commits[0].oid }),
			expectedHeadSha: pr.headSha,
			paths
		});

		const draftPath = join(
			paths.state.drafts,
			`${ref.repo}-${ref.number}-${wt.headSha.slice(0, 7)}.md`
		);
		await mkdir(paths.state.drafts, { recursive: true });
		let outcome: RunOutcome;
		let checks: ChecksSummary;
		try {
			const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
			const runDir = join(paths.state.run, runId);
			const gh = await writeGitHubContext(join(runDir, 'github'), pr, github);
			const checked = await runChecks({
				repo,
				author: pr.author,
				owner: ref.owner,
				worktree: wt.path,
				runDir,
				paths,
				timeoutMs: config.review.check_timeout_minutes * 60_000,
				...(opts.env && { env: opts.env }),
				...(opts.signal && { signal: opts.signal }),
				...(opts.checkSandbox && { sandbox: opts.checkSandbox }),
				...(opts.checkHostExec && { hostExec: opts.checkHostExec })
			});
			checks = checked.summary;
			outcome = await launchAgent({
				prompt: buildReviewPrompt({
					ref,
					pr,
					wt,
					gh,
					checksPath: checked.path,
					draftPath,
					maxNits: config.review.max_nits,
					model
				}),
				paths,
				runId,
				model,
				maxTurns: config.review.max_turns,
				timeoutMs: config.review.timeout_minutes * 60_000,
				...(opts.claudeBin && { claudeBin: opts.claudeBin }),
				...(opts.env && { env: opts.env }),
				...(opts.signal && { signal: opts.signal })
			});
		} finally {
			if (!opts.keepWorktree) await removePrWorktree(wt);
		}

		const result = {
			ref: label,
			draftPath,
			draftExists: existsSync(draftPath),
			worktreePath: wt.path,
			model,
			checks,
			outcome
		};
		const recordPath = await logRun(paths, label, result);
		return { ...result, recordPath };
	} finally {
		await release();
	}
}

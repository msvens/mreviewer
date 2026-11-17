import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
	ConfigError,
	DraftError,
	describeChecks,
	LockBusyError,
	PostError,
	type PostOptions,
	type PostOutcome,
	type PreparedPost,
	PrRefError,
	postDraft,
	type ReviewOptions,
	type ReviewResult,
	reviewPr
} from '@mreviewer/core';

export const USAGE = `Usage: mreviewer <command> [options]

Commands:
  review <owner/repo#N | PR URL>   Review a PR and write a draft to state/drafts/
      --model <id>                 Override review.model from config.yaml
      --keep-worktree              Leave the PR worktree in place (debugging)

  post <draft | owner/repo#N>      Show a draft as a GitHub review, then post it after you confirm
                                   (owner/repo#N: that PR's newest draft)
      --yes                        Post without asking
      --dry-run                    Only show what would be posted
      --force                      Post a draft that was posted before
      --allow-stale                Post although the PR has new commits since the review

  help                             Show this help`;

export interface Io {
	out: (line: string) => void;
	err: (line: string) => void;
	/** Ask a yes/no question; undefined when there is no terminal to ask on. */
	ask?: (question: string) => Promise<boolean>;
}

type PostDeps = PostOptions & { confirm?: (p: PreparedPost) => Promise<boolean> };

export interface Deps {
	reviewPr: (ref: string, opts: ReviewOptions) => Promise<ReviewResult>;
	postDraft: (input: string, opts: PostDeps) => Promise<PostOutcome>;
}

async function askTerminal(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
	} finally {
		rl.close();
	}
}

const defaultIo: Io = {
	out: (l) => console.log(l),
	err: (l) => console.error(l),
	...(process.stdin.isTTY && { ask: askTerminal })
};

const postLine = (r: ReviewResult): string => {
	const p = r.post;
	switch (p.status) {
		case 'posted':
			return `  posted:  ${p.url}`;
		case 'awaiting-approval':
			return `  post:    awaiting approval (${p.reason}): mreviewer post ${r.ref}`;
		case 'not-posted':
			return `  post:    not posted (${p.reason})`;
		case 'failed':
			return `  post:    FAILED (${p.error}); the draft is kept: mreviewer post ${r.ref}`;
	}
};

/** What `post` will send, for the person approving it. */
export function preview(p: PreparedPost): string[] {
	const { draft, review } = p;
	const sha7 = draft.headSha.slice(0, 7);
	const lines = [
		`${draft.ref.owner}/${draft.ref.repo}#${draft.ref.number} (reviewed ${sha7}) as a Comment review`,
		...(p.currentHeadSha !== draft.headSha
			? [`  NOTE: the PR head is now ${p.currentHeadSha.slice(0, 7)}; comments go on ${sha7}`]
			: [])
	];
	const label = (f: { severity: string; title: string }) => `[${f.severity}] ${f.title}`;
	for (const c of review.payload.comments) {
		const where =
			'line' in c
				? `${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}`
				: `${c.path} (file)`;
		const title = /\*\*(\[[^\]]+\] .*)\*\*/.exec(c.body)?.[1] ?? '';
		lines.push(`  inline:    ${where}  ${title}`);
	}
	for (const b of review.bodyOnly) lines.push(`  body only: ${label(b.finding)}  (${b.reason})`);
	if (draft.findings.length === 0) lines.push('  no findings: body only');
	lines.push('', '--- review body ---', review.payload.body.trimEnd(), '--- end ---');
	return lines;
}

async function post(args: string[], io: Io, deps: Deps): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: {
				yes: { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				force: { type: 'boolean' },
				'allow-stale': { type: 'boolean' }
			}
		});
	} catch (err) {
		io.err(`${(err as Error).message}\n\n${USAGE}`);
		return 1;
	}
	const [input, ...extra] = parsed.positionals;
	if (!input || extra.length > 0) {
		io.err(`post takes exactly one draft path or PR reference\n\n${USAGE}`);
		return 1;
	}
	const v = parsed.values;
	if (!v.yes && !v['dry-run'] && !io.ask) {
		io.err('Not a terminal: pass --yes to post, or --dry-run to preview.');
		return 1;
	}
	const ask = io.ask;
	try {
		const outcome = await deps.postDraft(input, {
			...(v.force && { force: true }),
			...(v['allow-stale'] && { allowStale: true }),
			...(!v['dry-run'] && {
				confirm: async (p: PreparedPost) => {
					for (const l of preview(p)) io.out(l);
					return v.yes ? true : (ask?.('Post this review?') ?? false);
				}
			})
		});
		if (outcome.status === 'previewed') {
			for (const l of preview(outcome.prepared)) io.out(l);
			return 0;
		}
		if (outcome.status === 'declined') {
			io.err('Not posted.');
			return 3;
		}
		io.out(`Posted: ${outcome.record.url}`);
		return 0;
	} catch (err) {
		const known =
			err instanceof ConfigError ||
			err instanceof LockBusyError ||
			err instanceof PrRefError ||
			err instanceof PostError ||
			err instanceof DraftError;
		io.err(known ? (err as Error).message : `Post failed: ${(err as Error).stack ?? err}`);
		return 2;
	}
}

export function summarize(r: ReviewResult): string[] {
	const res = r.outcome.result;
	const lines = [
		`${r.ref} reviewed with ${r.model}`,
		`  draft:   ${r.draftExists ? r.draftPath : '(none written)'}`,
		`  checks:  ${describeChecks(r.checks)}`,
		`  turns:   ${res?.numTurns ?? '?'}   duration: ${res?.durationMs ? `${Math.round(res.durationMs / 1000)}s` : '?'}`,
		postLine(r),
		`  record:  ${r.recordPath}`
	];
	const denials = res?.permissionDenials ?? [];
	if (denials.length > 0)
		lines.push(`  denied:  ${denials.length} tool call(s), see state/logs/denied.jsonl`);
	return lines;
}

/** Returns the process exit code. */
export async function run(
	argv: string[],
	io: Io = defaultIo,
	deps: Deps = { reviewPr, postDraft }
): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		io.out(USAGE);
		return command ? 0 : 1;
	}
	if (command === 'post') return post(rest, io, deps);
	if (command !== 'review') {
		io.err(`Unknown command: ${command}\n\n${USAGE}`);
		return 1;
	}

	let parsed;
	try {
		parsed = parseArgs({
			args: rest,
			allowPositionals: true,
			options: { model: { type: 'string' }, 'keep-worktree': { type: 'boolean' } }
		});
	} catch (err) {
		io.err(`${(err as Error).message}\n\n${USAGE}`);
		return 1;
	}
	const [ref, ...extra] = parsed.positionals;
	if (!ref || extra.length > 0) {
		io.err(`review takes exactly one PR reference\n\n${USAGE}`);
		return 1;
	}

	try {
		const result = await deps.reviewPr(ref, {
			...(parsed.values.model && { model: parsed.values.model }),
			...(parsed.values['keep-worktree'] && { keepWorktree: true })
		});
		for (const line of summarize(result)) io.out(line);
		const o = result.outcome;
		if (o.refusedApiKey)
			io.err('Stopped: the run started on an API key instead of your subscription.');
		if (o.timedOut) io.err('Stopped: the run hit its timeout (review.timeout_minutes).');
		if (o.result?.isError || o.exitCode !== 0)
			io.err(`The agent run failed: ${o.result?.subtype ?? `exit ${o.exitCode}`}`);
		if (!result.draftExists) io.err('No draft was written.');
		return result.draftExists && o.exitCode === 0 && !o.result?.isError ? 0 : 2;
	} catch (err) {
		const known =
			err instanceof ConfigError || err instanceof LockBusyError || err instanceof PrRefError;
		io.err(known ? (err as Error).message : `Review failed: ${(err as Error).stack ?? err}`);
		return 2;
	}
}

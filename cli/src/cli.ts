import { parseArgs } from 'node:util';
import {
	ConfigError,
	describeChecks,
	LockBusyError,
	PrRefError,
	type ReviewOptions,
	type ReviewResult,
	reviewPr
} from '@mreviewer/core';

export const USAGE = `Usage: mreviewer <command> [options]

Commands:
  review <owner/repo#N | PR URL>   Review a PR and write a draft to state/drafts/
      --model <id>                 Override review.model from config.yaml
      --keep-worktree              Leave the PR worktree in place (debugging)

  help                             Show this help`;

export interface Io {
	out: (line: string) => void;
	err: (line: string) => void;
}

export interface Deps {
	reviewPr: (ref: string, opts: ReviewOptions) => Promise<ReviewResult>;
}

const defaultIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

export function summarize(r: ReviewResult): string[] {
	const res = r.outcome.result;
	const lines = [
		`${r.ref} reviewed with ${r.model}`,
		`  draft:   ${r.draftExists ? r.draftPath : '(none written)'}`,
		`  checks:  ${describeChecks(r.checks)}`,
		`  turns:   ${res?.numTurns ?? '?'}   duration: ${res?.durationMs ? `${Math.round(res.durationMs / 1000)}s` : '?'}`,
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
	deps: Deps = { reviewPr }
): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		io.out(USAGE);
		return command ? 0 : 1;
	}
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

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripSecretEnv } from '../agent/env.ts';
import { SECRET_READ_PATHS } from '../agent/settings.ts';
import type { ResolvedRepo } from '../config.ts';
import { git } from '../git.ts';
import type { InstancePaths } from '../home.ts';
import { type Executor, hostExecutor, type SandboxPolicy } from './exec.ts';
import { type SandboxExecutor, srtExecutor } from './sandbox.ts';
import {
	type CheckSpec,
	detectToolchain,
	type Toolchain,
	toolchainById
} from './toolchains/index.ts';

export type StepStatus = 'passed' | 'failed' | 'timed-out' | 'skipped';

export interface StepResult {
	name: string;
	phase: 'prefetch' | 'install' | 'check';
	command: string;
	status: StepStatus;
	/** Why the step was skipped. */
	reason?: string;
	exitCode?: number | null;
	durationMs?: number;
	/** Full output. */
	log?: string;
	/** Last lines of output. */
	tail?: string;
}

export interface ChecksSummary {
	/** False when the gate stopped all checks; `reason` says why. */
	ran: boolean;
	reason?: string;
	toolchain?: string;
	/** Prefetch and install. */
	setup: StepResult[];
	checks: StepResult[];
	/** Installed dependency sources the agent may read. */
	dependencyDirs: string[];
	/** Tracked files the checks modified; core restored them before the agent ran. */
	restoredFiles: string[];
	/** What the check commands could reach. */
	sandbox: { network: string; localhost: boolean };
}

export interface RunChecksInput {
	repo: ResolvedRepo;
	/** GitHub login of the PR author. */
	author: string;
	/** Owner part of owner/repo. */
	owner: string;
	worktree: string;
	/** The review's run dir; results go to <runDir>/checks/. */
	runDir: string;
	paths: InstancePaths;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Parent environment for the commands (default: process.env), secrets stripped. */
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Test seams. */
	hostExec?: Executor;
	sandbox?: () => Promise<SandboxExecutor>;
}

export type GateDecision = { run: true } | { run: false; reason: string };

/** Whether PR code may run: the repo opted in and the author is trusted. */
export function checksGate(repo: ResolvedRepo, author: string, owner: string): GateDecision {
	if (!repo.run_checks) return { run: false, reason: `run_checks is off for ${repo.name}` };
	const trusted = (repo.trusted_authors ?? [owner]).map((a) => a.toLowerCase());
	if (!trusted.includes(author.toLowerCase())) {
		return {
			run: false,
			reason: `PR author ${author} is not in trusted_authors (${trusted.join(', ')}); PR code is not run`
		};
	}
	return { run: true };
}

const fileSafe = (name: string) => name.replace(/[^\w.-]/g, '_');

const statusOf = (r: { exitCode: number | null; timedOut: boolean }): StepStatus =>
	r.timedOut ? 'timed-out' : r.exitCode === 0 ? 'passed' : 'failed';

/** Tracked files changed in the worktree; restored so the agent reviews the PR as pushed. */
async function restoreTrackedFiles(worktree: string): Promise<string[]> {
	const status = await git(worktree, ['status', '--porcelain', '--untracked-files=no']);
	// git() trims the output, so the first line may have lost its leading status space.
	const changed = status
		.split('\n')
		.filter(Boolean)
		.map((l) => l.replace(/^.{1,2}? /, '').trim());
	if (changed.length > 0) {
		await git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
	}
	return changed;
}

async function writeSummary(dir: string, summary: ChecksSummary): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, 'checks.json');
	await writeFile(path, `${JSON.stringify(summary, null, '\t')}\n`);
	return path;
}

/**
 * Run the repo's checks on the PR head before the agent starts:
 * 1. prefetch (host, download only) when the toolchain needs it;
 * 2. install in the sandbox, with network to the toolchain's registries only;
 * 3. each check in the sandbox with no network.
 *
 * Writes go only to the worktree, the toolchain's cache under state/cache/ and the run's
 * checks/tmp. Results go to <runDir>/checks/checks.json plus one log per step.
 */
export async function runChecks(
	input: RunChecksInput
): Promise<{ summary: ChecksSummary; path: string }> {
	const dir = join(input.runDir, 'checks');
	const { repo, worktree } = input;
	const empty = (reason: string, toolchain?: string): ChecksSummary => ({
		ran: false,
		reason,
		...(toolchain && { toolchain }),
		setup: [],
		checks: [],
		dependencyDirs: [],
		restoredFiles: [],
		sandbox: { network: 'none', localhost: false }
	});
	const done = async (summary: ChecksSummary) => ({
		summary,
		path: await writeSummary(dir, summary)
	});

	const gate = checksGate(repo, input.author, input.owner);
	if (!gate.run) return done(empty(gate.reason));

	const tc: Toolchain | undefined = repo.toolchain
		? toolchainById(repo.toolchain)
		: detectToolchain(worktree);
	if (!tc) return done(empty('no supported toolchain found in the repo (pnpm-lock.yaml, go.mod)'));

	const specs: CheckSpec[] = repo.checks ?? (await tc.defaultChecks(worktree));
	if (specs.length === 0) {
		return done(empty(`no checks configured and no default checks found for ${tc.id}`, tc.id));
	}

	const cacheDir = join(input.paths.state.cache, tc.id);
	const tmpDir = join(dir, 'tmp');
	await mkdir(cacheDir, { recursive: true });
	await mkdir(tmpDir, { recursive: true });

	const home = input.home ?? homedir();
	const env: Record<string, string> = {
		...stripSecretEnv(input.env ?? process.env),
		...tc.env(cacheDir),
		TMPDIR: tmpDir,
		CI: 'true'
	};
	const policy = (allowedDomains: string[], allowLocalhost: boolean): SandboxPolicy => ({
		allowWrite: [worktree, cacheDir, tmpDir],
		denyRead: SECRET_READ_PATHS.map((p) => join(home, p)),
		allowedDomains,
		allowLocalhost
	});
	const base = {
		cwd: worktree,
		timeoutMs: input.timeoutMs,
		...(input.signal && { signal: input.signal })
	};

	const summary: ChecksSummary = {
		ran: true,
		toolchain: tc.id,
		setup: [],
		checks: [],
		dependencyDirs: tc.dependencyDirs(worktree, cacheDir),
		restoredFiles: [],
		sandbox: {
			network: tc.install
				? `install: ${tc.install.allowedDomains.join(', ')}; checks: none`
				: 'none',
			localhost: repo.allow_localhost
		}
	};
	let blocked: string | undefined;
	let step = 0;
	const run = async (
		exec: Executor,
		name: string,
		phase: StepResult['phase'],
		command: string,
		extra: { env?: Record<string, string>; policy?: SandboxPolicy }
	): Promise<StepResult> => {
		if (blocked) return { name, phase, command, status: 'skipped', reason: blocked };
		const log = join(dir, `${String(++step).padStart(2, '0')}-${fileSafe(name)}.log`);
		const r = await exec({
			...base,
			command,
			env: { ...env, ...extra.env },
			logPath: log,
			...(extra.policy && { policy: extra.policy })
		});
		return {
			name,
			phase,
			command,
			status: statusOf(r),
			exitCode: r.exitCode,
			durationMs: r.durationMs,
			log,
			tail: r.tail
		};
	};

	const sandbox = await (input.sandbox ?? srtExecutor)();
	try {
		if (tc.prefetch) {
			const r = await run(
				input.hostExec ?? hostExecutor,
				'prefetch',
				'prefetch',
				tc.prefetch.run,
				{}
			);
			summary.setup.push(r);
			if (r.status !== 'passed') blocked = 'prefetch failed';
		}
		if (tc.install) {
			const r = await run(sandbox.exec, 'install', 'install', tc.install.run, {
				policy: policy(tc.install.allowedDomains, false)
			});
			summary.setup.push(r);
			if (r.status === 'failed' || r.status === 'timed-out') blocked = 'install failed';
		}
		for (const spec of specs) {
			if (input.signal?.aborted) blocked = 'aborted';
			summary.checks.push(
				await run(sandbox.exec, spec.name, 'check', spec.run, {
					env: tc.checkEnv?.(cacheDir) ?? {},
					policy: policy([], repo.allow_localhost)
				})
			);
		}
	} finally {
		await sandbox.dispose();
		summary.restoredFiles = await restoreTrackedFiles(worktree);
	}
	return done(summary);
}

/** One line for the CLI and the run record, e.g. "3 passed, 1 failed". */
export function describeChecks(s: ChecksSummary): string {
	if (!s.ran) return `not run (${s.reason})`;
	const steps = [...s.setup, ...s.checks];
	const count = (st: StepStatus) =>
		steps.filter((c) => c.phase === 'check' && c.status === st).length;
	const parts = (['passed', 'failed', 'timed-out', 'skipped'] as const)
		.map((st) => [st, count(st)] as const)
		.filter(([, n]) => n > 0)
		.map(([st, n]) => `${n} ${st}`);
	const setupFailed = s.setup.find((x) => x.status !== 'passed');
	return [parts.join(', '), setupFailed && `${setupFailed.name} ${setupFailed.status}`]
		.filter(Boolean)
		.join('; ');
}

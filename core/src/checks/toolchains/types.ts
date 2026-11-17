import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** One check: a shell command run in the worktree with no network. */
export interface CheckSpec {
	name: string;
	run: string;
}

/**
 * How core prepares and checks a repo of one package manager. Adding a language means adding one
 * of these and registering it in TOOLCHAINS; the runner, the gate and the sandbox policy stay as
 * they are.
 *
 * Each toolchain gets its own cache directory under state/cache/<id>/. Every command it declares
 * runs in the sandbox, except `prefetch`, which runs on the host and must only download (never run
 * code from the PR). Use it only for tools that cannot work behind the sandbox, like Go's TLS.
 */
export interface Toolchain {
	id: string;
	/** True if the worktree uses this toolchain (usually: its lockfile exists). */
	detect(worktree: string): boolean;
	/** Environment for every step: cache locations under `cacheDir`. */
	env(cacheDir: string): Record<string, string>;
	/** Extra environment for the check commands only. */
	checkEnv?(cacheDir: string): Record<string, string>;
	/** Download step on the host, outside the sandbox. Must not execute PR code. */
	prefetch?: { run: string };
	/** Install step in the sandbox, with network to these hosts only. */
	install?: { run: string; allowedDomains: string[] };
	/** Checks to run when the repo config lists none. */
	defaultChecks(worktree: string): Promise<CheckSpec[]>;
	/** Where installed dependency sources live, for the agent to read. */
	dependencyDirs(worktree: string, cacheDir: string): string[];
}

export const hasFile = (dir: string, ...names: string[]) =>
	names.some((n) => existsSync(join(dir, n)));

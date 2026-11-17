import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, type Executor, hostExecutor } from '../src/checks/exec.ts';
import { checksGate, describeChecks, runChecks } from '../src/checks/run.ts';
import type { SandboxExecutor } from '../src/checks/sandbox.ts';
import { go } from '../src/checks/toolchains/go.ts';
import { detectToolchain } from '../src/checks/toolchains/index.ts';
import { pnpm } from '../src/checks/toolchains/pnpm.ts';
import type { ResolvedRepo } from '../src/config.ts';
import { instancePaths } from '../src/home.ts';
import { createGitFixture, type GitFixture, sh } from './helpers/git-fixture.ts';

const repo = (over: Partial<ResolvedRepo> = {}): ResolvedRepo => ({
	name: 'o/r',
	path: 'r',
	dir: '/x/r',
	stack: 'ts',
	role: 'active',
	authority: false,
	run_checks: true,
	allow_localhost: false,
	...over
});

describe('checksGate', () => {
	it('runs only when the repo opted in and the author is trusted', () => {
		expect(checksGate(repo(), 'O', 'o')).toEqual({ run: true });
		expect(checksGate(repo({ run_checks: false }), 'o', 'o')).toMatchObject({ run: false });
		expect(checksGate(repo(), 'dependabot[bot]', 'o')).toMatchObject({
			run: false,
			reason: expect.stringContaining('not in trusted_authors')
		});
		expect(checksGate(repo({ trusted_authors: ['alice'] }), 'alice', 'o')).toEqual({ run: true });
		expect(checksGate(repo({ trusted_authors: ['alice'] }), 'o', 'o')).toMatchObject({
			run: false
		});
	});
});

describe('toolchains', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'mreviewer-tc-'));
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	it('detects pnpm from its lockfile and picks the known scripts as checks', async () => {
		await writeFile(join(dir, 'pnpm-lock.yaml'), '');
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'vite build' } })
		);
		expect(detectToolchain(dir)?.id).toBe('pnpm');
		expect(await pnpm.defaultChecks(dir)).toEqual([
			{ name: 'lint', run: 'pnpm run lint' },
			{ name: 'test', run: 'pnpm run test' }
		]);
	});

	it('detects go and adds golangci-lint only when the repo configures it', async () => {
		await writeFile(join(dir, 'go.mod'), 'module x\n');
		expect(detectToolchain(dir)?.id).toBe('go');
		expect((await go.defaultChecks(dir)).map((c) => c.name)).toEqual(['vet', 'test']);
		await writeFile(join(dir, '.golangci.yml'), '');
		expect((await go.defaultChecks(dir)).map((c) => c.name)).toEqual(['vet', 'test', 'lint']);
	});

	it('finds nothing in a repo without a supported lockfile', () => {
		expect(detectToolchain(dir)).toBeUndefined();
	});
});

describe('hostExecutor', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'mreviewer-exec-'));
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	const req = (command: string, timeoutMs = 10_000): ExecRequest => ({
		command,
		cwd: dir,
		env: { PATH: process.env.PATH ?? '' },
		timeoutMs,
		logPath: join(dir, 'logs', 'x.log')
	});

	it('logs output and reports the exit code and tail', async () => {
		const r = await hostExecutor(req('echo out; echo err >&2; exit 3'));
		expect(r).toMatchObject({ exitCode: 3, timedOut: false, tail: expect.stringContaining('err') });
		expect(await readFile(join(dir, 'logs', 'x.log'), 'utf8')).toContain('out');
	});

	it('kills the whole process group on timeout', async () => {
		const r = await hostExecutor(req('sleep 30 & sleep 30; wait', 300));
		expect(r.timedOut).toBe(true);
		expect(r.durationMs).toBeLessThan(10_000);
	});
});

describe('runChecks', () => {
	let fx: GitFixture;
	let paths: ReturnType<typeof instancePaths>;
	let calls: ExecRequest[];
	let hostCalls: ExecRequest[];
	/** Detached worktree of the PR head, as core prepares it. */
	let wt: string;

	beforeEach(async () => {
		fx = await createGitFixture();
		wt = join(fx.root, 'wt');
		sh(fx.local, 'worktree', 'add', '--detach', '--quiet', wt, fx.headSha);
		paths = instancePaths(join(fx.root, 'inst'));
		calls = [];
		hostCalls = [];
	});
	afterEach(() => rm(fx.root, { recursive: true, force: true }));

	/** Fake sandbox: records each request, answers by command. */
	const fakeSandbox =
		(
			answer: (
				req: ExecRequest
			) =>
				| { exitCode: number | null; timedOut?: boolean }
				| Promise<{ exitCode: number | null; timedOut?: boolean }>
		) =>
		async (): Promise<SandboxExecutor> => ({
			exec: async (req) => {
				calls.push(req);
				const a = await answer(req);
				return { timedOut: false, durationMs: 1, tail: `ran ${req.command}`, ...a };
			},
			dispose: async () => undefined
		});
	const fakeHost: Executor = async (req) => {
		hostCalls.push(req);
		return { exitCode: 0, timedOut: false, durationMs: 1, tail: '' };
	};

	const run = (r: Partial<ResolvedRepo>, sandbox: () => Promise<SandboxExecutor>, author = 'o') =>
		runChecks({
			repo: repo(r),
			author,
			owner: 'o',
			worktree: wt,
			runDir: join(paths.state.run, 'r1'),
			paths,
			timeoutMs: 1000,
			env: { PATH: '/bin', GH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k', HOME: '/h' },
			home: '/h',
			sandbox,
			hostExec: fakeHost
		});

	it('installs with registry network, then runs checks with none, and writes the summary', async () => {
		await writeFile(join(wt, 'pnpm-lock.yaml'), '');
		const checks = [
			{ name: 'typecheck', run: 'pnpm run typecheck' },
			{ name: 'test', run: 'pnpm run test' }
		];
		const { summary, path } = await run(
			{ checks },
			fakeSandbox((r) => ({ exitCode: r.command.includes('test') ? 1 : 0 }))
		);

		expect(calls.map((c) => c.command)).toEqual([
			'pnpm install --frozen-lockfile',
			'pnpm run typecheck',
			'pnpm run test'
		]);
		const [install, check] = calls;
		expect(install?.policy?.allowedDomains).toContain('registry.npmjs.org');
		expect(check?.policy).toMatchObject({ allowedDomains: [], allowLocalhost: false });
		expect(check?.policy?.allowWrite).toEqual([
			wt,
			join(paths.state.cache, 'pnpm'),
			join(paths.state.run, 'r1', 'checks', 'tmp')
		]);
		expect(check?.policy?.denyRead).toContain('/h/.ssh');
		expect(check?.env).toMatchObject({ CI: 'true', XDG_DATA_HOME: expect.any(String) });
		expect(check?.env).not.toHaveProperty('GH_TOKEN');
		expect(check?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(hostCalls).toEqual([]);

		expect(summary.checks.map((c) => [c.name, c.status])).toEqual([
			['typecheck', 'passed'],
			['test', 'failed']
		]);
		expect(describeChecks(summary)).toBe('1 passed, 1 failed');
		expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
			ran: true,
			toolchain: 'pnpm'
		});
	});

	it('prefetches go modules on the host and runs go checks offline', async () => {
		await writeFile(join(wt, 'go.mod'), 'module x\n');
		const { summary } = await run(
			{ allow_localhost: true },
			fakeSandbox(() => ({ exitCode: 0 }))
		);
		expect(hostCalls.map((c) => c.command)).toEqual(['go mod download']);
		expect(hostCalls[0]?.env).toMatchObject({ GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' });
		expect(hostCalls[0]?.env).not.toHaveProperty('GOPROXY');
		expect(calls.map((c) => c.command)).toEqual(['go vet ./...', 'go test ./... -count=1']);
		expect(calls[0]?.env.GOPROXY).toBe('off');
		expect(calls[0]?.policy?.allowLocalhost).toBe(true);
		expect(summary.dependencyDirs).toEqual([join(paths.state.cache, 'go', 'mod')]);
	});

	it('skips the checks when install fails or times out', async () => {
		await writeFile(join(wt, 'pnpm-lock.yaml'), '');
		const { summary } = await run(
			{ checks: [{ name: 'test', run: 'pnpm run test' }] },
			fakeSandbox((r) =>
				r.command.startsWith('pnpm install') ? { exitCode: null, timedOut: true } : { exitCode: 0 }
			)
		);
		expect(calls).toHaveLength(1);
		expect(summary.setup[0]?.status).toBe('timed-out');
		expect(summary.checks[0]).toMatchObject({ status: 'skipped', reason: 'install failed' });
	});

	it('runs nothing for an untrusted author, a repo without opt-in or an unknown toolchain', async () => {
		await writeFile(join(wt, 'pnpm-lock.yaml'), '');
		const sandbox = fakeSandbox(() => ({ exitCode: 0 }));
		expect((await run({}, sandbox, 'stranger')).summary).toMatchObject({ ran: false });
		expect((await run({ run_checks: false }, sandbox)).summary.reason).toMatch(/run_checks is off/);
		await rm(join(wt, 'pnpm-lock.yaml'));
		expect((await run({}, sandbox)).summary.reason).toMatch(/no supported toolchain/);
		expect(calls).toEqual([]);
	});

	it('restores tracked files that a check modified', async () => {
		await writeFile(join(wt, 'pnpm-lock.yaml'), '');
		const { summary } = await run(
			{ checks: [{ name: 'fmt', run: 'pnpm run format' }] },
			fakeSandbox(async (r) => {
				// Simulate a formatter rewriting a tracked file.
				if (r.command === 'pnpm run format') await writeFile(join(r.cwd, 'a.txt'), 'rewritten\n');
				return { exitCode: 0 };
			})
		);
		expect(summary.restoredFiles).toEqual(['a.txt']);
		expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
		expect(existsSync(join(paths.state.run, 'r1', 'checks', 'checks.json'))).toBe(true);
	});
});

/**
 * Lockdown test for check commands: runs real shell commands under the sandbox runtime with the
 * policies runChecks uses, standing in for malicious PR code (tests, install scripts), and
 * verifies the effects on disk and on the network.
 *
 * Local only: needs macOS and network access. Run with `pnpm test:integration`. The fixture lives
 * under the home directory on purpose: the sandbox always allows writes to its own temp directory,
 * so a fixture under /tmp could hide filesystem leaks.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripSecretEnv } from '../src/agent/env.ts';
import { SECRET_READ_PATHS } from '../src/agent/settings.ts';
import type { ExecResult, SandboxPolicy } from '../src/checks/exec.ts';
import { type SandboxExecutor, srtExecutor } from '../src/checks/sandbox.ts';

const EPERM = /operation not permitted|EPERM/i;
const isMac = process.platform === 'darwin';

describe.skipIf(!isMac)('check sandbox lockdown', () => {
	let root: string;
	let worktree: string;
	let cache: string;
	let tmp: string;
	let outside: string;
	let secret: string;
	let sandbox: SandboxExecutor;
	let server: Server;
	let port: number;

	beforeAll(async () => {
		root = await mkdtemp(join(homedir(), '.mreviewer-checks-lockdown-'));
		worktree = join(root, 'state', 'worktrees', 'r-1');
		cache = join(root, 'state', 'cache', 'pnpm');
		tmp = join(root, 'state', 'run', 'r1', 'checks', 'tmp');
		// Stand-ins for everything a check must not touch: the repo's .git, drafts, config.
		outside = join(root, 'state', 'drafts');
		secret = join(root, 'secret');
		for (const d of [worktree, cache, tmp, outside, secret, join(root, 'config')])
			await mkdir(d, { recursive: true });
		await writeFile(join(secret, 'token'), 'BANANA-CANARY\n');
		sandbox = await srtExecutor();
		server = createServer((_req, res) => res.end('local-ok'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await sandbox?.dispose();
		server?.close();
		if (root) await rm(root, { recursive: true, force: true });
	});

	const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
		allowWrite: [worktree, cache, tmp],
		denyRead: [...SECRET_READ_PATHS.map((p) => join(homedir(), p)), secret],
		allowedDomains: [],
		allowLocalhost: false,
		...over
	});
	let n = 0;
	const sh = async (
		command: string,
		over: Partial<SandboxPolicy> = {}
	): Promise<ExecResult & { out: string }> => {
		const logPath = join(root, 'logs', `${++n}.log`);
		const r = await sandbox.exec({
			command,
			cwd: worktree,
			env: { ...stripSecretEnv(process.env), TMPDIR: tmp },
			timeoutMs: 60_000,
			logPath,
			policy: policy(over)
		});
		return { ...r, out: await readFile(logPath, 'utf8') };
	};

	it('writes to the worktree, the cache and its temp dir', async () => {
		const r = await sh(
			`echo ok > w.txt && echo ok > '${cache}/c.txt' && echo ok > "$TMPDIR/t.txt"`
		);
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(tmp, 't.txt'))).toBe(true);
	});

	it.each([
		['drafts', () => `echo p > '${outside}/pwned.md'`, () => join(outside, 'pwned.md')],
		[
			'config',
			() => `echo p > '${root}/config/pwned.yaml'`,
			() => join(root, 'config', 'pwned.yaml')
		],
		['home', () => `echo p > '${root}/pwned.txt'`, () => join(root, 'pwned.txt')]
	])('cannot write to %s', async (_name, cmd, target) => {
		const r = await sh(cmd());
		expect(r.exitCode).not.toBe(0);
		expect(r.out).toMatch(EPERM);
		expect(existsSync(target())).toBe(false);
	});

	it('cannot read denied paths', async () => {
		const r = await sh(`cat '${secret}/token'; ls ~/.ssh`);
		expect(r.out).not.toContain('BANANA-CANARY');
		expect(r.out).toMatch(EPERM);
	});

	it('has no network during checks', async () => {
		const r = await sh('curl -sS -m 10 -o /dev/null https://registry.npmjs.org/');
		expect(r.exitCode).not.toBe(0);
	});

	it('reaches only the allowed hosts during install', async () => {
		const domains = { allowedDomains: ['registry.npmjs.org'] };
		const ok = await sh(
			'curl -sS -m 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/',
			domains
		);
		expect(ok.out).toContain('200');
		const blocked = await sh('curl -sS -m 15 -o /dev/null https://example.com/', domains);
		expect(blocked.exitCode).not.toBe(0);
	});

	it('reaches localhost only when the repo allows it', async () => {
		const cmd = `curl -sS -m 5 --noproxy '*' http://127.0.0.1:${port}/`;
		expect((await sh(cmd)).out).not.toContain('local-ok');
		expect((await sh(cmd, { allowLocalhost: true })).out).toContain('local-ok');
	});
});

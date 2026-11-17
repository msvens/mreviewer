import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What a sandboxed command may touch. Paths are absolute. */
export interface SandboxPolicy {
	/** Directories the command may write to (plus the sandbox runtime's own temp dir). */
	allowWrite: string[];
	/** Paths the command may not read. */
	denyRead: string[];
	/** Hosts reachable through the sandbox proxy. Empty: no network. */
	allowedDomains: string[];
	/** Let the command connect to any port on localhost (test databases). */
	allowLocalhost: boolean;
}

export interface ExecRequest {
	/** Shell command, run with bash -c. */
	command: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	/** Combined stdout and stderr go here. */
	logPath: string;
	/** Required by the sandboxed executor, ignored by the host executor. */
	policy?: SandboxPolicy;
	signal?: AbortSignal;
}

export interface ExecResult {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** The last lines of output. */
	tail: string;
}

/** Runs one command. Production: `hostExecutor` and `srtExecutor`; tests inject fakes. */
export type Executor = (req: ExecRequest) => Promise<ExecResult>;

const TAIL_LINES = 40;
const TAIL_BUFFER = 16 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Spawn argv in its own process group, log its output, and kill the whole group on timeout or
 * abort. Must stay asynchronous: the sandbox's network proxy runs in this process.
 */
export async function spawnLogged(
	argv: string[],
	req: Omit<ExecRequest, 'command' | 'policy'>
): Promise<ExecResult> {
	await mkdir(dirname(req.logPath), { recursive: true });
	const log = createWriteStream(req.logPath);
	const started = Date.now();
	const [bin, ...args] = argv;
	if (!bin) throw new Error('spawnLogged: empty argv');
	const child = spawn(bin, args, {
		cwd: req.cwd,
		env: req.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});

	let tail = '';
	const onData = (chunk: Buffer) => {
		log.write(chunk);
		tail = (tail + chunk.toString('utf8')).slice(-TAIL_BUFFER);
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);

	let timedOut = false;
	let killTimer: NodeJS.Timeout | undefined;
	const killGroup = (sig: NodeJS.Signals) => {
		try {
			if (child.pid) process.kill(-child.pid, sig);
		} catch {
			// Already gone.
		}
	};
	const stop = () => {
		killGroup('SIGTERM');
		killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, req.timeoutMs);
	req.signal?.addEventListener('abort', stop, { once: true });
	if (req.signal?.aborted) stop();

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve(code));
	}).finally(() => {
		clearTimeout(timer);
		if (killTimer) clearTimeout(killTimer);
		req.signal?.removeEventListener('abort', stop);
	});
	await new Promise<void>((resolve) => log.end(resolve));

	return {
		exitCode,
		timedOut,
		durationMs: Date.now() - started,
		tail: tail.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
	};
}

/** Runs a command directly on the host. Only for download steps that execute no PR code. */
export const hostExecutor: Executor = (req) => spawnLogged(['/bin/bash', '-c', req.command], req);

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_DIR } from '../engine.ts';
import type { InstancePaths } from '../home.ts';
import { buildAgentEnv } from './env.ts';
import { assemblePersona, loadPersonaParts } from './persona.ts';
import { buildAgentSettings, loadAgentPermissions, protectedRunFiles } from './settings.ts';
import { type RunInit, type RunResult, StreamCollector } from './stream.ts';

/** Built-in tools the reviewer gets. --restricted removes everything not named here. */
export const DEFAULT_TOOLS = [
	'Bash',
	'Read',
	'Grep',
	'Glob',
	'Write',
	'Edit',
	'Skill',
	'Agent'
] as const;

/** Grace period between SIGTERM and SIGKILL when a run is stopped. */
const KILL_GRACE_MS = 5_000;

export interface LaunchOptions {
	prompt: string;
	paths: InstancePaths;
	model: string;
	maxTurns: number;
	timeoutMs: number;
	/** Reviewer PAT. Omitted: `gh` runs unauthenticated. */
	token?: string;
	agentDir?: string;
	tools?: readonly string[];
	readDirs?: string[];
	extraAllow?: string[];
	signal?: AbortSignal;
	claudeBin?: string;
	runId?: string;
	/** Parent environment to derive the agent's from (default: process.env). */
	env?: NodeJS.ProcessEnv;
}

export interface RunOutcome {
	runId: string;
	runDir: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	/** The run started on an API key instead of the subscription and was stopped. */
	refusedApiKey: boolean;
	init: RunInit | undefined;
	result: RunResult | undefined;
	stderr: string;
}

export interface ClaudeArgsInput {
	prompt: string;
	agentDir: string;
	settingsPath: string;
	personaPath: string;
	model: string;
	maxTurns: number;
	tools: readonly string[];
}

/**
 * Arguments for the agent's `claude -p` run.
 * --restricted ignores user/project/local settings, every CLAUDE.md and ambient MCP servers, so the
 * run sees only the --settings file, the --plugin-dir skills and the appended persona.
 */
export function buildClaudeArgs(a: ClaudeArgsInput): string[] {
	return [
		'-p',
		a.prompt,
		'--restricted',
		'--strict-mcp-config',
		'--tools',
		a.tools.join(','),
		'--plugin-dir',
		a.agentDir,
		'--settings',
		a.settingsPath,
		'--permission-mode',
		'dontAsk',
		'--append-system-prompt-file',
		a.personaPath,
		'--no-session-persistence',
		'--output-format',
		'stream-json',
		'--verbose',
		'--model',
		a.model,
		'--max-turns',
		String(a.maxTurns)
	];
}

/** Prepare a run directory under state/run/ and run the agent once. */
export async function launchAgent(opts: LaunchOptions): Promise<RunOutcome> {
	const agentDir = opts.agentDir ?? AGENT_DIR;
	const runId =
		opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
	const runDir = join(opts.paths.state.run, runId);
	const ghConfigDir = join(runDir, 'gh');
	const tmpDir = join(runDir, 'tmp');
	await mkdir(ghConfigDir, { recursive: true });
	await mkdir(tmpDir, { recursive: true });

	const files = protectedRunFiles(runDir);
	const permissions = await loadAgentPermissions(agentDir);
	const settings = buildAgentSettings({
		paths: opts.paths,
		runDir,
		agentDir,
		permissions,
		...(opts.readDirs && { readDirs: opts.readDirs }),
		...(opts.extraAllow && { extraAllow: opts.extraAllow })
	});
	await writeFile(files.settings, `${JSON.stringify(settings, null, '\t')}\n`);
	await writeFile(files.persona, assemblePersona(await loadPersonaParts(agentDir, opts.paths)));

	const args = buildClaudeArgs({
		prompt: opts.prompt,
		agentDir,
		settingsPath: files.settings,
		personaPath: files.persona,
		model: opts.model,
		maxTurns: opts.maxTurns,
		tools: opts.tools ?? DEFAULT_TOOLS
	});
	const env = buildAgentEnv(opts.env ?? process.env, {
		instanceRoot: opts.paths.root,
		ghConfigDir,
		tmpDir,
		...(opts.token && { token: opts.token })
	});

	const child = spawn(opts.claudeBin ?? 'claude', args, {
		cwd: runDir,
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const collector = new StreamCollector();
	const raw = createWriteStream(join(runDir, 'stream.jsonl'));
	let stderr = '';
	let timedOut = false;
	let aborted = false;
	let refusedApiKey = false;

	let killTimer: NodeJS.Timeout | undefined;
	const stop = () => {
		if (child.exitCode !== null || child.killed) return;
		child.kill('SIGTERM');
		killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
	};
	const timeout = setTimeout(() => {
		timedOut = true;
		stop();
	}, opts.timeoutMs);
	const onAbort = () => {
		aborted = true;
		stop();
	};
	opts.signal?.addEventListener('abort', onAbort, { once: true });
	if (opts.signal?.aborted) onAbort();

	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	const lines = createInterface({ input: child.stdout });
	lines.on('line', (line) => {
		raw.write(`${line}\n`);
		const init = collector.push(line);
		// Reviews must run on the subscription. Fail closed if an API key got through anyway.
		if (init && init.apiKeySource !== 'none') {
			refusedApiKey = true;
			stop();
		}
	});

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve(code));
	}).finally(() => {
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		opts.signal?.removeEventListener('abort', onAbort);
		raw.end();
	});

	return {
		runId,
		runDir,
		exitCode,
		timedOut,
		aborted,
		refusedApiKey,
		init: collector.init,
		result: collector.result,
		stderr
	};
}

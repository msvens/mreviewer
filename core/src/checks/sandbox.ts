import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { type Executor, type SandboxPolicy, spawnLogged } from './exec.ts';

function runtimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
	return {
		network: {
			allowedDomains: policy.allowedDomains,
			deniedDomains: [],
			allowLocalBinding: policy.allowLocalhost
		},
		filesystem: {
			denyRead: policy.denyRead,
			allowWrite: policy.allowWrite,
			denyWrite: []
		}
	};
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface SandboxExecutor {
	exec: Executor;
	/** Stop the proxy and release the sandbox. Call once, after the last command. */
	dispose(): Promise<void>;
}

/**
 * Executor that runs each command under Anthropic's sandbox runtime (Seatbelt on macOS, the same
 * engine as Claude Code's sandbox). The runtime is process-global: one executor at a time, and
 * commands run one after another, each under its own policy.
 *
 * Network goes through a proxy inside this process that allows only `policy.allowedDomains`.
 */
export async function srtExecutor(): Promise<SandboxExecutor> {
	if (!SandboxManager.isSupportedPlatform()) {
		throw new Error('The sandbox runtime does not support this platform; checks cannot run.');
	}
	let initialized = false;

	const exec: Executor = async (req) => {
		if (!req.policy) throw new Error('srtExecutor: a sandbox policy is required');
		const config = runtimeConfig(req.policy);
		if (initialized) SandboxManager.updateConfig(config);
		else {
			await SandboxManager.initialize(config);
			initialized = true;
		}
		// The runtime sets TMPDIR to its own shared temp dir; point it back into the run.
		const tmp = req.env.TMPDIR;
		const command = tmp ? `export TMPDIR=${shellQuote(tmp)}; ${req.command}` : req.command;
		const wrapped = await SandboxManager.wrapWithSandboxArgv(
			command,
			'/bin/bash',
			undefined,
			req.signal,
			req.cwd
		);
		try {
			const env: Record<string, string> = { ...req.env };
			for (const [k, v] of Object.entries(wrapped.env)) if (v !== undefined) env[k] = v;
			return await spawnLogged(wrapped.argv, { ...req, env });
		} finally {
			SandboxManager.cleanupAfterCommand();
		}
	};

	return {
		exec,
		dispose: async () => {
			if (initialized) await SandboxManager.reset();
		}
	};
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstancePaths } from '../home.ts';

/** Command rules shipped in agent/permissions.json. */
export interface AgentPermissions {
	allow: string[];
	deny: string[];
}

export async function loadAgentPermissions(agentDir: string): Promise<AgentPermissions> {
	const raw = JSON.parse(
		await readFile(join(agentDir, 'permissions.json'), 'utf8')
	) as Partial<AgentPermissions>;
	if (!Array.isArray(raw.allow) || !Array.isArray(raw.deny)) {
		throw new Error(`${agentDir}/permissions.json must have "allow" and "deny" arrays`);
	}
	return { allow: raw.allow, deny: raw.deny };
}

/**
 * Locations under the user's home the agent must never read, even through a child process.
 * Shell rc files are here because they commonly export secrets (API keys, tokens).
 */
export const SECRET_READ_PATHS = [
	'.ssh',
	'.aws',
	'.gnupg',
	'.config/gh',
	'.claude',
	'.netrc',
	'.npmrc',
	'.docker',
	'.kube',
	'.zshrc',
	'.zprofile',
	'.zshenv',
	'.bashrc',
	'.bash_profile',
	'.profile',
	'Library/Keychains'
] as const;

/** Hosts the agent's shell commands may reach. */
export const ALLOWED_DOMAINS = ['github.com', 'api.github.com'] as const;

export interface AgentSettingsInput {
	paths: InstancePaths;
	/** Directory of this run, inside state/run/. Holds the settings and persona files. */
	runDir: string;
	/** The engine's agent/ directory (plugin, persona, permissions). Never writable. */
	agentDir: string;
	permissions: AgentPermissions;
	/** Extra read-only directories, e.g. authority repos under the projects root. */
	readDirs?: string[];
	/** Extra allow rules. Used by the lockdown test; deny rules still win. */
	extraAllow?: string[];
	home?: string;
}

/** Files of a run that the agent must not change mid-run, although they sit in state/. */
export function protectedRunFiles(runDir: string) {
	return {
		settings: join(runDir, 'settings.json'),
		persona: join(runDir, 'system-prompt.md')
	};
}

/**
 * Build the settings file passed to `claude -p --restricted --settings <file>`.
 *
 * `--restricted` ignores user, project and local settings and all CLAUDE.md files, so this file is
 * the agent's entire configuration. Two layers enforce the boundary:
 * - permissions: the command allowlist (dontAsk denies anything unlisted) and file-tool rules;
 * - sandbox: OS-level limits on every shell command and its children (writes, reads, network).
 *
 * All paths are absolute: sandbox "." would resolve relative to this file's directory.
 */
export function buildAgentSettings(input: AgentSettingsInput) {
	const home = input.home ?? homedir();
	const { paths, runDir, agentDir, permissions } = input;
	const run = protectedRunFiles(runDir);
	// Read/Edit rules use "//" for absolute paths.
	const abs = (p: string) => `/${p}`;
	const secrets = SECRET_READ_PATHS.map((p) => join(home, p));

	return {
		autoMemoryEnabled: false,
		permissions: {
			defaultMode: 'dontAsk',
			// File tools may reach the instance and the PR worktrees (under state/) besides the run dir.
			// Not --add-dir: that would also load .claude/skills shipped inside a PR's worktree.
			additionalDirectories: [paths.config.root, paths.state.root, ...(input.readDirs ?? [])],
			allow: [
				...permissions.allow,
				...(input.extraAllow ?? []),
				`Edit(${abs(paths.state.root)}/**)`
			],
			deny: [
				...permissions.deny,
				`Edit(${abs(paths.config.root)}/**)`,
				`Edit(${abs(agentDir)}/**)`,
				`Edit(${abs(run.settings)})`,
				`Edit(${abs(run.persona)})`,
				...secrets.map((p) => `Read(${abs(p)}/**)`),
				...secrets.map((p) => `Read(${abs(p)})`)
			]
		},
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			// Default true: any sandboxed command would run without matching the allowlist.
			autoAllowBashIfSandboxed: false,
			filesystem: {
				allowWrite: [paths.state.root],
				denyWrite: [paths.config.root, agentDir, run.settings, run.persona],
				denyRead: secrets
			},
			network: {
				allowedDomains: [...ALLOWED_DOMAINS]
			}
		}
	};
}

export type AgentSettings = ReturnType<typeof buildAgentSettings>;

export interface AgentEnvInput {
	/** Fine-grained PAT; omitted means `gh` runs unauthenticated. */
	token?: string;
	instanceRoot: string;
	/** Empty directory: `gh` must not see the user's own (Keychain-backed) login. */
	ghConfigDir: string;
	/** Inside the run dir, so the sandbox's temp-dir write access stays under state/. */
	tmpDir: string;
}

/**
 * Variables never passed to the agent:
 * - ANTHROPIC_*: an API key takes precedence over the subscription login in `-p` mode;
 * - CLAUDECODE / CLAUDE_CODE_* / CLAUDE_PID / CLAUDE_EFFORT: markers of a parent Claude session;
 * - GH_* / GITHUB_TOKEN: only the reviewer PAT may reach `gh`;
 * - SSH_AUTH_SOCK: the user's SSH agent could authenticate git pushes.
 */
const STRIPPED = [
	/^ANTHROPIC_/,
	/^CLAUDECODE$/,
	/^CLAUDE_CODE_/,
	/^CLAUDE_PID$/,
	/^CLAUDE_EFFORT$/,
	/^GH_/,
	/^GITHUB_TOKEN$/,
	/^SSH_AUTH_SOCK$/
];

export function buildAgentEnv(parent: NodeJS.ProcessEnv, input: AgentEnvInput): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined && !STRIPPED.some((re) => re.test(key))) env[key] = value;
	}
	env.MREVIEWER_HOME = input.instanceRoot;
	env.GH_CONFIG_DIR = input.ghConfigDir;
	env.GH_PROMPT_DISABLED = '1';
	env.GIT_TERMINAL_PROMPT = '0';
	env.TMPDIR = input.tmpDir;
	if (input.token) env.GH_TOKEN = input.token;
	return env;
}

import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../src/agent/env.ts';

const parent = {
	PATH: '/usr/bin',
	HOME: '/Users/u',
	ANTHROPIC_API_KEY: 'sk-ant-secret',
	ANTHROPIC_BASE_URL: 'https://example',
	CLAUDECODE: '1',
	CLAUDE_CODE_SESSION_ID: 'abc',
	CLAUDE_PID: '42',
	GH_TOKEN: 'personal',
	GH_HOST: 'github.example',
	GITHUB_TOKEN: 'personal',
	SSH_AUTH_SOCK: '/tmp/agent.sock'
};
const input = {
	instanceRoot: '/i',
	ghConfigDir: '/i/state/run/r/gh',
	tmpDir: '/i/state/run/r/tmp'
};

describe('buildAgentEnv', () => {
	it('strips API keys, parent Claude session markers, the user gh login and the SSH agent', () => {
		const env = buildAgentEnv(parent, input);
		for (const key of [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_BASE_URL',
			'CLAUDECODE',
			'CLAUDE_CODE_SESSION_ID',
			'CLAUDE_PID',
			'GH_HOST',
			'GITHUB_TOKEN',
			'SSH_AUTH_SOCK'
		]) {
			expect(env, key).not.toHaveProperty(key);
		}
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/Users/u');
	});

	it('points gh at an empty config dir and temp files into the run dir', () => {
		const env = buildAgentEnv(parent, input);
		expect(env.GH_CONFIG_DIR).toBe('/i/state/run/r/gh');
		expect(env.TMPDIR).toBe('/i/state/run/r/tmp');
		expect(env.MREVIEWER_HOME).toBe('/i');
		expect(env.GH_PROMPT_DISABLED).toBe('1');
		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
	});

	it('passes only the reviewer token, and only when given', () => {
		expect(buildAgentEnv(parent, input)).not.toHaveProperty('GH_TOKEN');
		expect(buildAgentEnv(parent, { ...input, token: 'reviewer' }).GH_TOKEN).toBe('reviewer');
	});
});

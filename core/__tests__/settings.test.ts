import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	buildAgentSettings,
	loadAgentPermissions,
	SECRET_READ_PATHS
} from '../src/agent/settings.ts';
import { AGENT_DIR } from '../src/engine.ts';
import { instancePaths } from '../src/home.ts';

const paths = instancePaths('/Users/u/.mreviewer');
const runDir = '/Users/u/.mreviewer/state/run/r1';
const agentDir = '/engine/agent';
const settings = buildAgentSettings({
	paths,
	runDir,
	agentDir,
	permissions: { allow: ['Bash(git log *)'], deny: ['Bash(git push *)'] },
	home: '/Users/u'
});

describe('buildAgentSettings', () => {
	it('denies anything not allowlisted and keeps the allowlist meaningful under the sandbox', () => {
		expect(settings.permissions.defaultMode).toBe('dontAsk');
		expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(false);
		expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
		expect(settings.sandbox.failIfUnavailable).toBe(true);
		expect(settings.autoMemoryEnabled).toBe(false);
	});

	it('lets shell commands write only to state/', () => {
		expect(settings.sandbox.filesystem.allowWrite).toEqual(['/Users/u/.mreviewer/state']);
		expect(settings.sandbox.filesystem.denyWrite).toEqual(
			expect.arrayContaining([
				'/Users/u/.mreviewer/config',
				agentDir,
				`${runDir}/settings.json`,
				`${runDir}/system-prompt.md`
			])
		);
	});

	it('lets the file tools edit only state/, never config/, the engine or the run files', () => {
		expect(settings.permissions.allow).toContain('Edit(//Users/u/.mreviewer/state/**)');
		expect(settings.permissions.deny).toEqual(
			expect.arrayContaining([
				'Edit(//Users/u/.mreviewer/config/**)',
				'Edit(//engine/agent/**)',
				`Edit(/${runDir}/settings.json)`,
				'Bash(git push *)'
			])
		);
	});

	it('blocks reading credentials and shell rc files', () => {
		const denyRead = settings.sandbox.filesystem.denyRead;
		for (const p of ['.ssh', '.config/gh', 'Library/Keychains', '.zshrc']) {
			expect(denyRead).toContain(`/Users/u/${p}`);
			expect(settings.permissions.deny).toContain(`Read(//Users/u/${p}/**)`);
		}
		expect(denyRead).toHaveLength(SECRET_READ_PATHS.length);
	});

	it('uses absolute paths only, since sandbox "." is relative to the settings file', () => {
		const fs = settings.sandbox.filesystem;
		for (const p of [
			...fs.allowWrite,
			...fs.denyWrite,
			...fs.denyRead,
			...settings.permissions.additionalDirectories
		]) {
			expect(isAbsolute(p), p).toBe(true);
		}
	});

	it('limits network access to GitHub', () => {
		expect(settings.sandbox.network.allowedDomains).toEqual(['github.com', 'api.github.com']);
	});
});

describe('agent/permissions.json', () => {
	it('loads and never allows pushing, committing, fetching or raw API calls', async () => {
		const perms = await loadAgentPermissions(AGENT_DIR);
		expect(perms.deny).toEqual(
			expect.arrayContaining([
				'Bash(git push *)',
				'Bash(git * push *)',
				'Bash(git commit *)',
				'Bash(git fetch *)',
				'Bash(gh api *)',
				'Bash(gh pr merge *)',
				'Bash(security *)'
			])
		);
		for (const rule of perms.allow)
			expect(rule).not.toMatch(/push|commit|fetch|worktree|gh api|merge/);
	});
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	ConfigError,
	DEFAULT_MODEL,
	findRepo,
	loadConfig,
	parseConfig,
	postMode
} from '../src/config.ts';
import { instancePaths } from '../src/home.ts';

const minimal = `
projects_root: ~/projects
repos:
  - name: msvens/chess
    path: github.com/msvens/chess
    stack: sveltekit
`;

describe('parseConfig', () => {
	it('fills defaults for everything optional', () => {
		const c = parseConfig(minimal);
		expect(c.review).toMatchObject({
			model: DEFAULT_MODEL,
			max_turns: 80,
			timeout_minutes: 30,
			max_nits: 3,
			auto_post: false
		});
		expect(c.repos[0]).toMatchObject({
			role: 'active',
			authority: false,
			run_checks: false,
			allow_localhost: false
		});
		expect(c.repos[0]?.trusted_authors).toBeUndefined();
		expect(c.review.check_timeout_minutes).toBe(10);
		expect(c.scheduler).toBe('launchd');
	});

	it('accepts the shipped template unchanged', async () => {
		const { readFile } = await import('node:fs/promises');
		const template = await readFile(
			join(import.meta.dirname, '../../templates/instance/config/config.yaml'),
			'utf8'
		);
		expect(parseConfig(template).review.model).toBe('claude-opus-5-5');
	});

	it('names the offending key on invalid input', () => {
		expect(() => parseConfig(`${minimal}\nreview:\n  max_turns: -1\n`)).toThrow(
			/review\.max_turns/
		);
		expect(() => parseConfig(`${minimal}\nunknown_key: 1\n`)).toThrow(ConfigError);
		expect(() =>
			parseConfig('projects_root: x\nrepos:\n  - name: not-a-repo\n    path: p\n    stack: go\n')
		).toThrow(/repos\.0\.name/);
		expect(() => parseConfig('repos: [')).toThrow(/invalid YAML/);
	});

	it('parses check settings and rejects unknown toolchains and bad check names', () => {
		const withChecks = (extra: string) =>
			parseConfig(`${minimal}    run_checks: true\n${extra}`).repos[0];
		expect(
			withChecks(
				'    toolchain: pnpm\n    trusted_authors: [msvens]\n    checks:\n      - name: check:svelte\n        run: pnpm run check:svelte\n'
			)
		).toMatchObject({
			run_checks: true,
			toolchain: 'pnpm',
			trusted_authors: ['msvens'],
			checks: [{ name: 'check:svelte', run: 'pnpm run check:svelte' }]
		});
		expect(() => withChecks('    toolchain: cargo\n')).toThrow(/repos\.0\.toolchain.*pnpm, go/s);
		expect(() => withChecks('    checks:\n      - name: ../x\n        run: x\n')).toThrow(
			/repos\.0\.checks\.0\.name/
		);
	});
});

describe('findRepo', () => {
	const c = parseConfig(
		`${minimal}  - name: msvens/mphotos\n    path: /abs/mphotos\n    stack: go\n`
	);

	it('resolves the checkout under projects_root, case-insensitively', () => {
		expect(findRepo(c, 'MSVENS/Chess', '/Users/u').dir).toBe(
			'/Users/u/projects/github.com/msvens/chess'
		);
	});

	it('keeps an absolute path', () => {
		expect(findRepo(c, 'msvens/mphotos', '/Users/u').dir).toBe('/abs/mphotos');
	});

	it('lists the configured repos when one is missing', () => {
		expect(() => findRepo(c, 'msvens/nope')).toThrow(/msvens\/chess, msvens\/mphotos/);
	});
});

describe('loadConfig', () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'mreviewer-config-'));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it('explains a missing config file', async () => {
		await expect(loadConfig(instancePaths(join(dir, 'none')))).rejects.toThrow(
			/Copy templates\/instance/
		);
	});

	it('loads config/config.yaml', async () => {
		const paths = instancePaths(join(dir, 'inst'));
		await mkdir(paths.config.root, { recursive: true });
		await writeFile(paths.config.configYaml, minimal);
		expect((await loadConfig(paths)).repos).toHaveLength(1);
	});
});

describe('postMode', () => {
	const config = (global: boolean, repo: string) =>
		parseConfig(
			`projects_root: /p\nreview:\n  auto_post: ${global}\nrepos:\n  - name: o/r\n    path: r\n    stack: ts\n${repo}`
		);

	it('waits for approval unless auto_post is on for the repo, globally or per repo', () => {
		const off = config(false, '');
		expect(postMode(off, off.repos[0]!, 'o', 'o')).toEqual({
			mode: 'approve',
			reason: 'auto_post is off for o/r'
		});
		const global = config(true, '');
		expect(postMode(global, global.repos[0]!, 'o', 'o')).toEqual({ mode: 'auto' });
		const repoOff = config(true, '    auto_post: false\n');
		expect(postMode(repoOff, repoOff.repos[0]!, 'o', 'o').mode).toBe('approve');
		const repoOn = config(false, '    auto_post: true\n');
		expect(postMode(repoOn, repoOn.repos[0]!, 'O', 'o').mode).toBe('auto');
	});

	it('auto-posts only for trusted authors', () => {
		const c = config(false, '    auto_post: true\n');
		expect(postMode(c, c.repos[0]!, 'dependabot[bot]', 'o')).toMatchObject({
			mode: 'approve',
			reason: expect.stringContaining('not in trusted_authors')
		});
		const alice = config(false, '    auto_post: true\n    trusted_authors: [alice]\n');
		expect(postMode(alice, alice.repos[0]!, 'alice', 'o').mode).toBe('auto');
		expect(postMode(alice, alice.repos[0]!, 'o', 'o').mode).toBe('approve');
	});
});

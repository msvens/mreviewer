import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { InstancePaths } from './home.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const repoSchema = z.strictObject({
	/** GitHub owner/repo. */
	name: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/repo'),
	/** Local checkout, relative to projects_root (or absolute). */
	path: z.string().min(1),
	stack: z.string().min(1),
	role: z.enum(['active', 'maintained', 'stale']).default('active'),
	/** A source of conventions. */
	authority: z.boolean().default(false),
	/** Run typecheck/tests on the PR head (phase 1, item B). */
	run_checks: z.boolean().default(false)
});

const reviewSchema = z.strictObject({
	model: z.string().min(1).default(DEFAULT_MODEL),
	max_turns: z.number().int().positive().default(80),
	timeout_minutes: z.number().positive().default(30),
	/** Only Comment reviews are possible with a PAT on your own PRs. */
	review_event: z.enum(['comment']).default('comment'),
	max_nits: z.number().int().min(0).default(3),
	auto_post: z.boolean().default(false)
});

export const configSchema = z.strictObject({
	projects_root: z.string().min(1),
	scheduler: z.enum(['launchd', 'ui']).default('launchd'),
	poll_interval_minutes: z.number().positive().default(15),
	quiet_hours: z
		.string()
		.regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'must be HH:MM-HH:MM')
		.optional(),
	review: reviewSchema.prefault({}),
	notify: z.enum(['macos', 'none']).default('macos'),
	repos: z.array(repoSchema).default([])
});

export type Config = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

/** Parse and validate config.yaml contents. Errors name the offending key. */
export function parseConfig(text: string, source = 'config.yaml'): Config {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (err) {
		throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
	}
	const result = configSchema.safeParse(raw ?? {});
	if (!result.success) {
		const issues = result.error.issues.map(
			(i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`
		);
		throw new ConfigError(`${source} is invalid:\n${issues.join('\n')}`);
	}
	return result.data;
}

export async function loadConfig(paths: InstancePaths): Promise<Config> {
	let text: string;
	try {
		text = await readFile(paths.config.configYaml, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new ConfigError(
				`No config at ${paths.config.configYaml}. Copy templates/instance/ to the instance directory.`
			);
		}
		throw err;
	}
	return parseConfig(text, paths.config.configYaml);
}

function expandHome(p: string, home: string): string {
	if (p === '~') return home;
	return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

export interface ResolvedRepo extends RepoConfig {
	/** Absolute path of the local checkout. */
	dir: string;
}

/** Find a watched repo by owner/repo (case-insensitive) and resolve its local checkout. */
export function findRepo(config: Config, name: string, home: string = homedir()): ResolvedRepo {
	const repo = config.repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
	if (!repo) {
		const known = config.repos.map((r) => r.name).join(', ') || 'none';
		throw new ConfigError(`${name} is not in config.yaml repos (configured: ${known})`);
	}
	const root = resolve(expandHome(config.projects_root, home));
	const path = expandHome(repo.path, home);
	return { ...repo, dir: isAbsolute(path) ? resolve(path) : resolve(root, path) };
}

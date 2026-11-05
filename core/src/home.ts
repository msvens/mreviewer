import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Environment variable that points at the private instance directory. */
export const HOME_ENV = 'MREVIEWER_HOME';

/** Default instance directory, relative to the user's home. */
export const DEFAULT_HOME_DIRNAME = '.mreviewer';

/**
 * Resolve the instance directory: `$MREVIEWER_HOME` if set, else `~/.mreviewer`.
 * A leading `~` is expanded and relative paths are resolved against `cwd`, so callers
 * always get an absolute path (sandbox rules need absolute paths).
 */
export function resolveHome(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	cwd: string = process.cwd()
): string {
	const raw = env[HOME_ENV]?.trim();
	if (!raw) return join(home, DEFAULT_HOME_DIRNAME);
	const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Absolute paths of the instance layout. `config/` is human-approved; `state/` is agent-written. */
export interface InstancePaths {
	root: string;
	config: {
		root: string;
		configYaml: string;
		persona: string;
		feedbackRules: string;
		conventions: string;
		tools: string;
	};
	state: {
		root: string;
		reviewed: string;
		runLock: string;
		queue: string;
		drafts: string;
		proposals: string;
		feedback: string;
		worktrees: string;
		logs: string;
		evals: string;
		run: string;
	};
}

export function instancePaths(root: string): InstancePaths {
	if (!isAbsolute(root)) throw new Error(`instance root must be absolute, got: ${root}`);
	const config = join(root, 'config');
	const state = join(root, 'state');
	return {
		root,
		config: {
			root: config,
			configYaml: join(config, 'config.yaml'),
			persona: join(config, 'persona.md'),
			feedbackRules: join(config, 'feedback-rules.md'),
			conventions: join(config, 'conventions'),
			tools: join(config, 'tools')
		},
		state: {
			root: state,
			reviewed: join(state, 'reviewed.json'),
			runLock: join(state, 'run.lock'),
			queue: join(state, 'queue'),
			drafts: join(state, 'drafts'),
			proposals: join(state, 'proposals'),
			feedback: join(state, 'feedback'),
			worktrees: join(state, 'worktrees'),
			logs: join(state, 'logs'),
			evals: join(state, 'evals'),
			run: join(state, 'run')
		}
	};
}

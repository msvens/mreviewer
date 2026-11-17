import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run git in `cwd` and return trimmed stdout. Variables that would redirect git to another
 * repository or work tree are dropped, and prompts are disabled.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])
		delete env[key];
	try {
		const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const e = err as Error & { stderr?: string };
		throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${e.stderr?.trim() || e.message}`, {
			cause: err
		});
	}
}

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@t',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@t'
};

export const sh = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

export interface GitFixture {
	root: string;
	/** Bare remote, with main and refs/pull/1/head like GitHub. */
	origin: string;
	/** The user's local checkout (a clone of origin). */
	local: string;
	baseSha: string;
	headSha: string;
	/** Advance main on origin after the PR branched, so merge-base != base. */
	mainAfterPr: string;
}

/** origin: main (2 commits, then 1 more after the PR branched) + refs/pull/1/head; local: a clone. */
export async function createGitFixture(): Promise<GitFixture> {
	const root = await mkdtemp(join(tmpdir(), 'mreviewer-git-'));
	const author = join(root, 'author');
	const origin = join(root, 'origin.git');
	const local = join(root, 'local');

	sh(root, 'init', '-q', '--bare', origin);
	sh(root, 'init', '-q', '-b', 'main', author);
	await writeFile(join(author, 'a.txt'), 'one\n');
	sh(author, 'add', '.');
	sh(author, 'commit', '-q', '-m', 'one');
	const baseSha = sh(author, 'rev-parse', 'HEAD');

	sh(author, 'switch', '-q', '-c', 'feature');
	await writeFile(join(author, 'a.txt'), 'one\ntwo\n');
	sh(author, 'commit', '-q', '-am', 'feature');
	const headSha = sh(author, 'rev-parse', 'HEAD');

	sh(author, 'switch', '-q', 'main');
	await writeFile(join(author, 'b.txt'), 'later\n');
	sh(author, 'add', '.');
	sh(author, 'commit', '-q', '-m', 'main moves on');
	const mainAfterPr = sh(author, 'rev-parse', 'HEAD');

	sh(author, 'push', '-q', origin, 'main', `${headSha}:refs/pull/1/head`);
	sh(root, 'clone', '-q', origin, local);
	return { root, origin, local, baseSha, headSha, mainAfterPr };
}

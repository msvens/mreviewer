import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitHub, IssueDetails, PrDetails } from './github.ts';

/** Files core writes for the agent. Paths are absolute. */
export interface GitHubContext {
	dir: string;
	/** Metadata, files, commits, linked issue refs, labels. No description. */
	pr: string;
	/** Linked issues with title and body. */
	issues: string;
	/** Conversation comments and reviews. */
	discussion: string;
	/** CI status of the head commit. */
	checks: string;
	/** The PR description, read last. */
	description: string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, '\t')}\n`;

/**
 * Fetch what the reviewer needs from GitHub and write it into the run directory. The agent reads
 * these files; it has no token and no `gh`. Linked issues that can't be fetched are recorded with
 * the error instead of failing the run.
 */
export async function writeGitHubContext(
	dir: string,
	pr: PrDetails,
	github: GitHub
): Promise<GitHubContext> {
	await mkdir(dir, { recursive: true });
	const ctx: GitHubContext = {
		dir,
		pr: join(dir, 'pr.json'),
		issues: join(dir, 'issues.json'),
		discussion: join(dir, 'discussion.json'),
		checks: join(dir, 'checks.json'),
		description: join(dir, 'description.md')
	};

	const issues: (IssueDetails | { owner: string; repo: string; number: number; error: string })[] =
		[];
	for (const ref of pr.closingIssues) {
		try {
			issues.push(await github.issue(ref));
		} catch (err) {
			issues.push({ ...ref, error: (err as Error).message.split('\n')[0] ?? 'failed' });
		}
	}

	const { body, comments, reviews, checks, ...meta } = pr;
	await writeFile(ctx.pr, json(meta));
	await writeFile(ctx.issues, json(issues));
	await writeFile(ctx.discussion, json({ comments, reviews }));
	await writeFile(ctx.checks, json(checks));
	await writeFile(ctx.description, body.trim() ? `${body.trim()}\n` : '(no description)\n');
	return ctx;
}

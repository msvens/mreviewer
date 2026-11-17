import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GitHub, toPrDetails } from '../src/github.ts';
import { writeGitHubContext } from '../src/prefetch.ts';

/** A trimmed `gh pr view --json …` response. */
const ghJson = {
	number: 33,
	title: 'Return groupsToday',
	url: 'https://github.com/o/r/pull/33',
	state: 'MERGED',
	isDraft: false,
	author: { login: 'msvens' },
	baseRefName: 'main',
	baseRefOid: 'b'.repeat(40),
	headRefName: 'feat',
	headRefOid: 'h'.repeat(40),
	labels: [{ name: 'feature' }],
	files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
	commits: [{ oid: 'c'.repeat(40), messageHeadline: 'Return groupsToday', messageBody: 'Details' }],
	closingIssuesReferences: [
		{ number: 12, repository: { name: 'other', owner: { login: 'x' } } },
		{ number: 13 }
	],
	body: 'The description',
	comments: [{ author: { login: 'bot' }, body: 'hi', createdAt: '2026-11-01' }],
	reviews: [{ author: { login: 'r' }, body: 'lgtm', state: 'APPROVED', submittedAt: '2026-11-02' }],
	statusCheckRollup: [
		{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
		{ context: 'legacy', state: 'SUCCESS' }
	]
};

describe('toPrDetails', () => {
	it('maps gh JSON, defaulting cross-repo issue refs to the PR repo', () => {
		const pr = toPrDetails(ghJson, { owner: 'o', repo: 'r', number: 33 });
		expect(pr).toMatchObject({
			author: 'msvens',
			baseSha: 'b'.repeat(40),
			headSha: 'h'.repeat(40),
			labels: ['feature']
		});
		expect(pr.commits).toEqual([
			{ oid: 'c'.repeat(40), headline: 'Return groupsToday', body: 'Details' }
		]);
		expect(pr.closingIssues).toEqual([
			{ owner: 'x', repo: 'other', number: 12 },
			{ owner: 'o', repo: 'r', number: 13 }
		]);
		expect(pr.checks).toEqual([
			{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
			{ name: 'legacy', status: 'SUCCESS', conclusion: '' }
		]);
	});

	it('tolerates missing fields', () => {
		expect(toPrDetails({}, { owner: 'o', repo: 'r', number: 1 })).toMatchObject({
			title: '',
			files: [],
			closingIssues: []
		});
	});
});

describe('writeGitHubContext', () => {
	it('writes the PR data without the description, which gets its own file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mreviewer-gh-'));
		const pr = toPrDetails(ghJson, { owner: 'o', repo: 'r', number: 33 });
		const github: GitHub = {
			pr: async () => pr,
			issue: async (ref) => {
				if (ref.number === 12) throw new Error('HTTP 404: Not Found\nmore');
				return { ...ref, title: 'T', body: 'B', state: 'OPEN', url: 'u' };
			}
		};
		const ctx = await writeGitHubContext(join(dir, 'github'), pr, github);

		const meta = JSON.parse(await readFile(ctx.pr, 'utf8'));
		expect(meta.title).toBe('Return groupsToday');
		expect(meta).not.toHaveProperty('body');
		expect(await readFile(ctx.description, 'utf8')).toBe('The description\n');
		expect(JSON.parse(await readFile(ctx.issues, 'utf8'))).toEqual([
			{ owner: 'x', repo: 'other', number: 12, error: 'HTTP 404: Not Found' },
			{ owner: 'o', repo: 'r', number: 13, title: 'T', body: 'B', state: 'OPEN', url: 'u' }
		]);
		expect(JSON.parse(await readFile(ctx.discussion, 'utf8')).reviews[0].state).toBe('APPROVED');
		await rm(dir, { recursive: true, force: true });
	});
});

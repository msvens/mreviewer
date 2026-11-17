import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHub, PrDetails, PrFileDiff, ReviewPayload } from '../src/github.ts';
import { instancePaths } from '../src/home.ts';
import { buildReview, diffLines } from '../src/post/build.ts';
import { DraftError, parseDraft, parseLocation } from '../src/post/draft.ts';
import { PostError, postDraft, resolveDraft } from '../src/post/post.ts';

const HEAD = 'a'.repeat(40);

/** A draft in the review-pr skill's format, shaped like a real one. */
const DRAFT = `# Review: o/svc#56 — Add job cancel

Head: ${HEAD} · Base: master (4722172) · Model: m · 2026-11-17

1 issue worth fixing before merge.

## Findings

### [should-fix] Cancel after the last file reports CANCELLED
Where: internal/server/drive.go:415-418 (also drive.go:388-404, video.go:137-181)
Problem: \`finishJob\` sets CANCELLED whenever the context is done.
- even after the loop finished
Evidence: \`cancelled := job.ctx.Err() != nil\`
Fix sketch: record whether the loop stopped early.
Verify: a unit test that cancels just before finishJob.

### [nit] Upload stops on client disconnect
Where: \`internal/server/drive.go:36\` (via addDrivePhoto)
Problem: undocumented behaviour change.

### [nit] CLAUDE.md points to the deprecated route
Where: CLAUDE.md:69-70
Problem: still says GET /api/drive/job/{jobid}.

### [nit] Something vague
Where: the job code
Problem: no location.

## Checked and ran
- go test ./...: passed.
`;

const PATCH = [
	'@@ -30,6 +30,7 @@ func x() {',
	' a', // 30
	' b', // 31
	'-old',
	'+new', // 32
	'+new2', // 33
	' c', // 34
	' d', // 35
	' e', // 36
	'@@ -410,3 +411,9 @@',
	' f', // 411
	'+g', // 412
	'+h', // 413
	'+i', // 414
	'+j', // 415
	'+k', // 416
	'+l', // 417
	' m', // 418
	' n', // 419
	'\\ No newline at end of file'
].join('\n');

const FILES: PrFileDiff[] = [
	{ path: 'internal/server/drive.go', status: 'modified', patch: PATCH },
	{ path: 'internal/server/video.go', status: 'modified' }
];

describe('parseDraft', () => {
	it('reads the ref, head, findings and their locations', () => {
		const d = parseDraft(DRAFT);
		expect(d.ref).toEqual({ owner: 'o', repo: 'svc', number: 56 });
		expect(d.headSha).toBe(HEAD);
		expect(d.title).toBe('Add job cancel');
		expect(d.findings.map((f) => [f.severity, f.where])).toEqual([
			['should-fix', { path: 'internal/server/drive.go', line: 418, startLine: 415 }],
			['nit', { path: 'internal/server/drive.go', line: 36 }],
			['nit', { path: 'CLAUDE.md', line: 70, startLine: 69 }],
			['nit', undefined]
		]);
		expect(d.findings[0]?.text).toContain('- even after the loop finished');
		expect(d.findings[0]?.text).not.toContain('Checked and ran');
		expect(d.body.startsWith('Head:')).toBe(true);
	});

	it('accepts a review without findings', () => {
		const d = parseDraft(`# Review: o/r#1 — T\n\nHead: ${HEAD}\n\n## Findings\n\nNo findings\n`);
		expect(d.findings).toEqual([]);
	});

	it('refuses a draft without a title or head line', () => {
		expect(() => parseDraft('Head: x\n', 'd.md')).toThrow(DraftError);
		expect(() => parseDraft('# Review: o/r#1 — T\n\nHead: abc\n')).toThrow(/Head: <40-char sha>/);
	});

	it('parses a location with the line range in either order', () => {
		expect(parseLocation('a/b.ts:9-3')).toEqual({ path: 'a/b.ts', line: 9, startLine: 3 });
		expect(parseLocation('a/b.ts:4-4')).toEqual({ path: 'a/b.ts', line: 4 });
		expect(parseLocation('nowhere')).toBeUndefined();
	});
});

describe('diffLines', () => {
	it('lists head-side lines of added and context lines only', () => {
		const lines = diffLines(PATCH);
		expect([...lines].slice(0, 7)).toEqual([30, 31, 32, 33, 34, 35, 36]);
		expect(lines.has(411) && lines.has(419)).toBe(true);
		expect(lines.has(37) || lines.has(410) || lines.has(420)).toBe(false);
	});
});

describe('buildReview', () => {
	it('anchors findings inline, per file or not at all, and keeps all of them in the body', () => {
		const { payload, bodyOnly } = buildReview(parseDraft(DRAFT), FILES, 'PREFIX');
		expect(payload).toMatchObject({ commit_id: HEAD, event: 'COMMENT' });
		expect(payload.body.startsWith('PREFIX\n\nHead:')).toBe(true);
		expect(payload.body).toContain('CLAUDE.md points to the deprecated route');
		expect(payload.comments).toMatchObject([
			{ path: 'internal/server/drive.go', line: 418, start_line: 415, side: 'RIGHT' },
			{ path: 'internal/server/drive.go', line: 36, side: 'RIGHT' }
		]);
		expect(payload.comments[0]?.body).toMatch(
			/^PREFIX\n\n\*\*\[should-fix\] Cancel after the last file reports CANCELLED\*\*\n\nWhere:/
		);
		expect(bodyOnly.map((b) => b.reason)).toEqual([
			'CLAUDE.md is not changed in this PR',
			'no file:line on its Where line'
		]);
	});

	it('falls back to one line of a range, then to a file-level comment', () => {
		const draft = (where: string) =>
			parseDraft(`# Review: o/r#1\n\nHead: ${HEAD}\n\n### [nit] x\nWhere: ${where}\n`);
		const first = (where: string) => buildReview(draft(where), FILES, 'P').payload.comments[0];
		expect(first('internal/server/drive.go:36-40')).toMatchObject({ line: 36 });
		expect(first('internal/server/drive.go:5-31')).toMatchObject({ line: 31 });
		const fileLevel = first('internal/server/drive.go:100');
		expect(fileLevel).toMatchObject({ path: 'internal/server/drive.go', subject_type: 'file' });
		expect(fileLevel).not.toHaveProperty('line');
		// No patch (binary or too large): file-level.
		expect(first('internal/server/video.go:3')).toMatchObject({ subject_type: 'file' });
	});
});

describe('postDraft', () => {
	let root: string;
	let paths: ReturnType<typeof instancePaths>;
	let posted: ReviewPayload[];
	let headSha: string;
	const draftPath = () => join(paths.state.drafts, 'svc-56-aaaaaaa.md');

	const github = (): GitHub => ({
		pr: async () => ({ headSha }) as PrDetails,
		issue: async () => {
			throw new Error('unused');
		},
		prFiles: async () => FILES,
		postReview: async (_ref, review) => {
			posted.push(review);
			return { id: 7, url: 'https://github.com/o/svc/pull/56#pullrequestreview-7' };
		}
	});
	const yes = async () => true;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mreviewer-post-'));
		paths = instancePaths(root);
		await mkdir(paths.config.root, { recursive: true });
		await writeFile(
			paths.config.configYaml,
			'projects_root: /x\nreview:\n  post_prefix: "[bot]"\n'
		);
		await mkdir(paths.state.drafts, { recursive: true });
		await writeFile(draftPath(), DRAFT);
		posted = [];
		headSha = HEAD;
	});
	afterEach(() => rm(root, { recursive: true, force: true }));

	it('previews without posting when nothing confirms', async () => {
		const r = await postDraft('o/svc#56', { paths, github: github() });
		expect(r.status).toBe('previewed');
		expect(r.prepared.review.payload.body.startsWith('[bot]')).toBe(true);
		expect(posted).toEqual([]);
	});

	it('posts after confirmation, records it and refuses a second post unless forced', async () => {
		const r = await postDraft(draftPath(), { paths, github: github(), confirm: yes });
		expect(r.status).toBe('posted');
		expect(posted).toHaveLength(1);
		const record = JSON.parse(await readFile(draftPath().replace(/\.md$/, '.posted.json'), 'utf8'));
		expect(record).toMatchObject({
			ref: 'o/svc#56',
			reviewId: 7,
			headSha: HEAD,
			inline: 2,
			fileLevel: 0,
			bodyOnly: 2
		});
		await expect(postDraft(draftPath(), { paths, github: github(), confirm: yes })).rejects.toThrow(
			/already posted .*pullrequestreview-7/
		);
		await postDraft(draftPath(), { paths, github: github(), confirm: yes, force: true });
		expect(posted).toHaveLength(2);
		expect(existsSync(paths.state.runLock)).toBe(false);
	});

	it('does nothing when the person declines', async () => {
		const r = await postDraft(draftPath(), { paths, github: github(), confirm: async () => false });
		expect(r.status).toBe('declined');
		expect(posted).toEqual([]);
		expect(existsSync(draftPath().replace(/\.md$/, '.posted.json'))).toBe(false);
	});

	it('refuses when the PR has new commits, and posts on the reviewed head with allowStale', async () => {
		headSha = 'b'.repeat(40);
		await expect(postDraft(draftPath(), { paths, github: github(), confirm: yes })).rejects.toThrow(
			PostError
		);
		const r = await postDraft(draftPath(), {
			paths,
			github: github(),
			confirm: yes,
			allowStale: true
		});
		expect(r.status).toBe('posted');
		expect(posted[0]?.commit_id).toBe(HEAD);
	});

	it('resolves a PR reference to its newest draft', async () => {
		const older = join(paths.state.drafts, 'svc-56-bbbbbbb.md');
		await writeFile(older, DRAFT);
		await utimes(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
		await writeFile(join(paths.state.drafts, 'svc-56-aaaaaaa.notes.md'), 'notes');
		expect(await resolveDraft('o/svc#56', paths)).toBe(draftPath());
		expect(await resolveDraft('https://github.com/o/svc/pull/56', paths)).toBe(draftPath());
		expect(await resolveDraft('svc-56-aaaaaaa.md', paths)).toBe(draftPath());
		await expect(resolveDraft('o/svc#57', paths)).rejects.toThrow(/No draft for o\/svc#57/);
	});
});

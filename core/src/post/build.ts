import type { PrFileDiff, ReviewComment, ReviewPayload } from '../github.ts';
import type { Draft, Finding } from './draft.ts';

/** Line numbers on the head side that a unified diff shows (added and context lines). */
export function diffLines(patch: string): Set<number> {
	const lines = new Set<number>();
	let right = 0;
	for (const l of patch.split('\n')) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
		if (hunk?.[1]) right = Number(hunk[1]);
		else if (l.startsWith('+') || l.startsWith(' ')) lines.add(right++);
		// '-' lines exist only on the base side; '\' marks a missing newline at end of file.
	}
	return lines;
}

export interface BodyOnly {
	finding: Finding;
	reason: string;
}

export interface BuiltReview {
	payload: ReviewPayload;
	/** Findings that are in the body but have no inline or file-level comment. */
	bodyOnly: BodyOnly[];
}

const commentBody = (prefix: string, f: Finding) =>
	`${prefix}\n\n**[${f.severity}] ${f.title}**\n\n${f.text}`;

/** Anchor one finding: inline on its lines, else on its file, else nowhere. */
function anchor(
	f: Finding,
	files: Map<string, PrFileDiff>,
	prefix: string
): ReviewComment | string {
	if (!f.where) return 'no file:line on its Where line';
	const { path, line, startLine } = f.where;
	const file = files.get(path);
	if (!file) return `${path} is not changed in this PR`;
	const body = commentBody(prefix, f);
	const shown = file.patch ? diffLines(file.patch) : new Set<number>();
	if (startLine !== undefined) {
		let whole = true;
		for (let n = startLine; n <= line; n++) if (!shown.has(n)) whole = false;
		if (whole) return { path, line, start_line: startLine, side: 'RIGHT', body };
		if (shown.has(line)) return { path, line, side: 'RIGHT', body };
		if (shown.has(startLine)) return { path, line: startLine, side: 'RIGHT', body };
	} else if (shown.has(line)) return { path, line, side: 'RIGHT', body };
	return { path, subject_type: 'file', body };
}

/**
 * The review to post: every finding stays in the body (anchors can go stale); findings on lines
 * in the diff also get an inline comment, findings elsewhere in a changed file a file-level one.
 */
export function buildReview(draft: Draft, files: PrFileDiff[], prefix: string): BuiltReview {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const comments: ReviewComment[] = [];
	const bodyOnly: BodyOnly[] = [];
	for (const f of draft.findings) {
		const a = anchor(f, byPath, prefix);
		if (typeof a === 'string') bodyOnly.push({ finding: f, reason: a });
		else comments.push(a);
	}
	return {
		payload: {
			commit_id: draft.headSha,
			event: 'COMMENT',
			body: `${prefix}\n\n${draft.body}\n`,
			comments
		},
		bodyOnly
	};
}

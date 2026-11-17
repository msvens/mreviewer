import { type PrRef, parsePrRef } from '../pr-ref.ts';

/** Where a finding points: one line or a range on the PR head side. */
export interface Location {
	path: string;
	line: number;
	startLine?: number;
}

export interface Finding {
	severity: string;
	title: string;
	/** Missing when the Where line is absent or names no file:line. */
	where?: Location;
	/** The finding's text below its heading, as written in the draft. */
	text: string;
}

export interface Draft {
	ref: PrRef;
	title: string;
	headSha: string;
	findings: Finding[];
	/** The draft without its `# Review:` title line. */
	body: string;
}

export class DraftError extends Error {
	constructor(path: string, problem: string) {
		super(`Cannot post ${path}: ${problem}`);
		this.name = 'DraftError';
	}
}

const TITLE = /^# Review: (\S+#\d+)(?: — (.*))?$/m;
const HEAD = /^Head: ([0-9a-f]{40})\b/m;
const FINDING = /^### \[([\w-]+)\] (.+)$/;
// The first file:line or file:start-end on the Where line; the path may be in backticks.
const WHERE = /`?([^\s`:()]+):(\d+)(?:-(\d+))?`?/;

export function parseLocation(where: string): Location | undefined {
	const m = WHERE.exec(where);
	if (!m?.[1] || !m[2]) return undefined;
	const first = Number(m[2]);
	const last = m[3] ? Number(m[3]) : undefined;
	if (last === undefined || last === first) return { path: m[1], line: first };
	return { path: m[1], line: Math.max(first, last), startLine: Math.min(first, last) };
}

/**
 * Parse a review-pr draft (agent/skills/review-pr/SKILL.md, step 7). People edit drafts before
 * posting, so only the title and head lines are required; a finding without a usable Where line
 * still goes in the review body.
 */
export function parseDraft(text: string, path = 'draft'): Draft {
	const title = TITLE.exec(text);
	if (!title?.[1]) throw new DraftError(path, 'no "# Review: owner/repo#N" title line');
	let ref: PrRef;
	try {
		ref = parsePrRef(title[1]);
	} catch {
		throw new DraftError(path, `"${title[1]}" is not owner/repo#N`);
	}
	const head = HEAD.exec(text);
	if (!head?.[1]) throw new DraftError(path, 'no "Head: <40-char sha>" line');

	const findings: Finding[] = [];
	let current: { severity: string; title: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		const body = current.lines.join('\n').trim();
		const whereLine = /^Where:(.*)$/m.exec(body)?.[1];
		const where = whereLine ? parseLocation(whereLine) : undefined;
		findings.push({
			severity: current.severity,
			title: current.title.trim(),
			...(where && { where }),
			text: body
		});
		current = undefined;
	};
	for (const line of text.split('\n')) {
		const f = FINDING.exec(line);
		if (f?.[1] && f[2]) {
			flush();
			current = { severity: f[1], title: f[2], lines: [] };
		} else if (/^#{1,3} /.test(line)) flush();
		else current?.lines.push(line);
	}
	flush();

	return {
		ref,
		title: title[2]?.trim() ?? '',
		headSha: head[1],
		findings,
		body: text.replace(TITLE, '').trim()
	};
}

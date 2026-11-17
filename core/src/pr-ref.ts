export interface PrRef {
	owner: string;
	repo: string;
	number: number;
}

export class PrRefError extends Error {
	constructor(input: string) {
		super(`Not a PR reference: "${input}". Use owner/repo#123 or a GitHub PR URL.`);
		this.name = 'PrRefError';
	}
}

const SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
// Also accepts the PR's tab URLs (/files, /commits, /checks) as copied from the browser.
const URL_FORM =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/[\w-]+)*\/?(?:[?#].*)?$/;

/** Parse `owner/repo#N` or a github.com pull request URL. */
export function parsePrRef(input: string): PrRef {
	const m = SHORT.exec(input.trim()) ?? URL_FORM.exec(input.trim());
	const number = Number(m?.[3]);
	if (!m || !m[1] || !m[2] || !Number.isSafeInteger(number) || number < 0) {
		throw new PrRefError(input);
	}
	return { owner: m[1], repo: m[2], number };
}

export const formatPrRef = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;
export const repoName = (r: PrRef) => `${r.owner}/${r.repo}`;

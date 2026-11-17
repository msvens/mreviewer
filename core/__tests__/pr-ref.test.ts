import { describe, expect, it } from 'vitest';
import { formatPrRef, PrRefError, parsePrRef } from '../src/pr-ref.ts';

describe('parsePrRef', () => {
	it('parses owner/repo#N and PR URLs', () => {
		expect(parsePrRef('msvens/chess#12')).toEqual({ owner: 'msvens', repo: 'chess', number: 12 });
		expect(parsePrRef('https://github.com/msvens/schack-se-sdk/pull/7/files')).toEqual({
			owner: 'msvens',
			repo: 'schack-se-sdk',
			number: 7
		});
		expect(parsePrRef('https://github.com/a/b.c/pull/3#discussion_r1')).toMatchObject({
			repo: 'b.c',
			number: 3
		});
	});

	it('rejects anything else', () => {
		for (const bad of [
			'chess#12',
			'msvens/chess',
			'msvens/chess#0',
			'msvens/chess#x',
			'https://gitlab.com/a/b/pull/1'
		]) {
			expect(() => parsePrRef(bad), bad).toThrow(PrRefError);
		}
	});

	it('round-trips through formatPrRef', () => {
		expect(formatPrRef(parsePrRef('a/b#1'))).toBe('a/b#1');
	});
});

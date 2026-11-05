import { describe, expect, it } from 'vitest';
import { readToken, TokenNotFoundError } from '../src/agent/token.ts';

describe('readToken', () => {
	it('reads the token from the Keychain item and trims the newline', async () => {
		let called: string[] = [];
		const token = await readToken('svc', async (file, args) => {
			called = [file, ...args];
			return { stdout: 'github_pat_x\n' };
		});
		expect(token).toBe('github_pat_x');
		expect(called).toEqual(['security', 'find-generic-password', '-s', 'svc', '-w']);
	});

	it('explains how to store the token when the item is missing or empty', async () => {
		await expect(readToken('svc', () => Promise.reject(new Error('44')))).rejects.toBeInstanceOf(
			TokenNotFoundError
		);
		await expect(readToken('svc', async () => ({ stdout: '\n' }))).rejects.toThrow(
			/add-generic-password -U/
		);
	});
});

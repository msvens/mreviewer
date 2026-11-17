import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRunLock, LockBusyError } from '../src/lock.ts';

let dir: string;
let lock: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mreviewer-lock-'));
	lock = join(dir, 'run.lock');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('acquireRunLock', () => {
	it('allows one holder at a time and releases', async () => {
		const release = await acquireRunLock(lock, 'a/b#1');
		await expect(acquireRunLock(lock, 'a/b#2')).rejects.toBeInstanceOf(LockBusyError);
		await release();
		expect(existsSync(lock)).toBe(false);
		await (
			await acquireRunLock(lock, 'a/b#2')
		)();
	});

	it('takes over a lock left by a process that is gone', async () => {
		await writeFile(lock, '2147483646 2026-01-01T00:00:00Z a/b#1\n');
		const release = await acquireRunLock(lock, 'a/b#2');
		await release();
	});
});

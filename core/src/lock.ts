import { open, readFile, rm } from 'node:fs/promises';

export class LockBusyError extends Error {
	readonly path: string;
	readonly holder: string;

	constructor(path: string, holder: string) {
		super(
			`Another run holds ${path} (${holder}). Wait for it to finish, or remove the file if that process is gone.`
		);
		this.name = 'LockBusyError';
		this.path = path;
		this.holder = holder;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Take the instance's run lock (state/run.lock): one review at a time across the CLI, launchd and
 * the UI. A lock left by a dead process is taken over. Returns the release function.
 */
export async function acquireRunLock(path: string, label: string): Promise<() => Promise<void>> {
	const content = `${process.pid} ${new Date().toISOString()} ${label}\n`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, 'wx');
			await handle.writeFile(content);
			await handle.close();
			return () => rm(path, { force: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			const holder = (await readFile(path, 'utf8').catch(() => '')).trim();
			const pid = Number(holder.split(' ')[0]);
			if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new LockBusyError(path, holder);
			await rm(path, { force: true });
		}
	}
	throw new LockBusyError(path, 'unknown');
}

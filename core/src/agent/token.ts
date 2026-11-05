import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Keychain service name the reviewer PAT is stored under. */
export const TOKEN_SERVICE = 'mreviewer-github-pat';

export class TokenNotFoundError extends Error {
	constructor(service: string) {
		super(
			`No GitHub token in the Keychain under "${service}". Store it with:\n` +
				`  security add-generic-password -U -a "$USER" -s ${service} -w`
		);
		this.name = 'TokenNotFoundError';
	}
}

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync: Exec = promisify(execFile);

/** Read the reviewer PAT from the macOS Keychain. The value is never logged. */
export async function readToken(
	service: string = TOKEN_SERVICE,
	exec: Exec = execFileAsync
): Promise<string> {
	let stdout: string;
	try {
		({ stdout } = await exec('security', ['find-generic-password', '-s', service, '-w']));
	} catch {
		throw new TokenNotFoundError(service);
	}
	const token = stdout.trim();
	if (!token) throw new TokenNotFoundError(service);
	return token;
}

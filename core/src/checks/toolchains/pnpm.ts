import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CheckSpec, hasFile, type Toolchain } from './types.ts';

/** package.json scripts run as default checks, in this order, when present. */
const DEFAULT_SCRIPTS = ['typecheck', 'check:svelte', 'lint', 'test'];

export const pnpm: Toolchain = {
	id: 'pnpm',
	detect: (wt) => hasFile(wt, 'pnpm-lock.yaml'),
	// pnpm keeps its store, metadata cache and global config under the XDG dirs when they are set:
	// all of it lands in the cache dir, and the user's own pnpm config is not read.
	env: (cache) => ({
		XDG_CACHE_HOME: join(cache, 'xdg-cache'),
		XDG_DATA_HOME: join(cache, 'xdg-data'),
		XDG_STATE_HOME: join(cache, 'xdg-state'),
		XDG_CONFIG_HOME: join(cache, 'xdg-config')
	}),
	// Dependency build scripts follow the repo's own allowBuilds; they run in the sandbox.
	install: {
		run: 'pnpm install --frozen-lockfile',
		allowedDomains: ['registry.npmjs.org', 'github.com', 'codeload.github.com']
	},
	async defaultChecks(wt) {
		let scripts: Record<string, unknown> = {};
		try {
			const pkg = JSON.parse(await readFile(join(wt, 'package.json'), 'utf8')) as {
				scripts?: Record<string, unknown>;
			};
			scripts = pkg.scripts ?? {};
		} catch {
			return [];
		}
		return DEFAULT_SCRIPTS.filter((s) => typeof scripts[s] === 'string').map((s): CheckSpec => ({
			name: s,
			run: `pnpm run ${s}`
		}));
	},
	dependencyDirs: (wt) => [join(wt, 'node_modules')]
};

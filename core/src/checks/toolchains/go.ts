import { join } from 'node:path';
import { type CheckSpec, hasFile, type Toolchain } from './types.ts';

export const go: Toolchain = {
	id: 'go',
	detect: (wt) => hasFile(wt, 'go.mod'),
	// GOTOOLCHAIN=local: a go.mod `toolchain` line must not download and run another Go.
	env: (cache) => ({
		GOMODCACHE: join(cache, 'mod'),
		GOCACHE: join(cache, 'build'),
		GOLANGCI_LINT_CACHE: join(cache, 'golangci-lint'),
		GOTOOLCHAIN: 'local',
		GOFLAGS: '-mod=readonly'
	}),
	// Go cannot verify TLS inside the macOS sandbox, so modules are downloaded on the host.
	// `go mod download` only fetches and verifies against go.sum; it runs no code from the repo.
	prefetch: { run: 'go mod download' },
	checkEnv: () => ({ GOPROXY: 'off' }),
	async defaultChecks(wt) {
		const checks: CheckSpec[] = [
			{ name: 'vet', run: 'go vet ./...' },
			{ name: 'test', run: 'go test ./... -count=1' }
		];
		if (hasFile(wt, '.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json')) {
			checks.push({ name: 'lint', run: 'golangci-lint run' });
		}
		return checks;
	},
	dependencyDirs: (_wt, cache) => [join(cache, 'mod')]
};

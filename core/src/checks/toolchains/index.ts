import { go } from './go.ts';
import { pnpm } from './pnpm.ts';
import type { Toolchain } from './types.ts';

export type { CheckSpec, Toolchain } from './types.ts';

export const TOOLCHAINS: readonly Toolchain[] = [pnpm, go];
export const TOOLCHAIN_IDS = TOOLCHAINS.map((t) => t.id);

export function toolchainById(id: string): Toolchain | undefined {
	return TOOLCHAINS.find((t) => t.id === id);
}

export function detectToolchain(worktree: string): Toolchain | undefined {
	return TOOLCHAINS.find((t) => t.detect(worktree));
}

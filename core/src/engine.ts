import { join, resolve } from 'node:path';

/** Root of the engine repo (this checkout), resolved from this file's location. */
export const ENGINE_ROOT = resolve(import.meta.dirname, '..', '..');

/** The runtime agent: a Claude Code plugin (skills) plus persona.md and permissions.json. */
export const AGENT_DIR = join(ENGINE_ROOT, 'agent');

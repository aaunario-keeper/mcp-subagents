import fs from 'fs/promises';
import path from 'path';
import { AgentRole, ToolAccessLevel, TOOL_ACCESS_LEVELS } from '../types.js';

export type ToolFeedbackAction = 'allow' | 'deny' | 'set_level' | 'clear' | 'note';

export interface ToolFeedbackInput {
  role: AgentRole;
  toolName: string;
  action: ToolFeedbackAction;
  level?: ToolAccessLevel;
  note?: string;
  source?: string;
}

export interface ToolAccessOverrides {
  roleLevels?: Partial<Record<AgentRole, ToolAccessLevel>>;
  allow?: Partial<Record<AgentRole, string[]>>;
  deny?: Partial<Record<AgentRole, string[]>>;
}

interface ToolFeedbackEntry {
  role: AgentRole;
  toolName: string;
  action: ToolFeedbackAction;
  level?: ToolAccessLevel;
  note?: string;
  source?: string;
  timestamp: string;
}

interface ToolFeedbackState {
  overrides: ToolAccessOverrides;
  history: ToolFeedbackEntry[];
}

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function normalizeOverrides(state: ToolFeedbackState): ToolFeedbackState {
  const overrides = state.overrides ?? {};
  const allow = overrides.allow ?? {};
  const deny = overrides.deny ?? {};

  for (const [role, list] of Object.entries(allow)) {
    allow[role as AgentRole] = Array.from(new Set(list));
  }
  for (const [role, list] of Object.entries(deny)) {
    deny[role as AgentRole] = Array.from(new Set(list));
  }

  state.overrides = {
    roleLevels: overrides.roleLevels ?? {},
    allow,
    deny,
  };

  return state;
}

export class ToolFeedbackStore {
  private filePath: string;
  private lock = new AsyncLock();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(): Promise<ToolFeedbackState> {
    return this.lock.withLock(async () => this.readInternal());
  }

  async applyFeedback(input: ToolFeedbackInput): Promise<ToolFeedbackState> {
    return this.lock.withLock(async () => {
      const state = await this.readInternal();
      const timestamp = new Date().toISOString();
      state.history.push({ ...input, timestamp });

      if (input.action === 'set_level') {
        if (!input.level || !TOOL_ACCESS_LEVELS.includes(input.level)) {
          return state;
        }
        state.overrides.roleLevels = state.overrides.roleLevels ?? {};
        state.overrides.roleLevels[input.role] = input.level;
        await this.writeInternal(state);
        return state;
      }

      if (input.action === 'allow' || input.action === 'deny' || input.action === 'clear') {
        state.overrides.allow = state.overrides.allow ?? {};
        state.overrides.deny = state.overrides.deny ?? {};

        const allow = state.overrides.allow[input.role] ?? [];
        const deny = state.overrides.deny[input.role] ?? [];

        if (input.action === 'allow') {
          allow.push(input.toolName);
          state.overrides.allow[input.role] = Array.from(new Set(allow));
          state.overrides.deny[input.role] = deny.filter((item) => item !== input.toolName);
        } else if (input.action === 'deny') {
          deny.push(input.toolName);
          state.overrides.deny[input.role] = Array.from(new Set(deny));
          state.overrides.allow[input.role] = allow.filter((item) => item !== input.toolName);
        } else if (input.action === 'clear') {
          state.overrides.allow[input.role] = allow.filter((item) => item !== input.toolName);
          state.overrides.deny[input.role] = deny.filter((item) => item !== input.toolName);
        }

        await this.writeInternal(state);
        return state;
      }

      await this.writeInternal(state);
      return state;
    });
  }

  private async readInternal(): Promise<ToolFeedbackState> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as ToolFeedbackState;
      return normalizeOverrides({
        overrides: parsed.overrides ?? {},
        history: parsed.history ?? [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { overrides: {}, history: [] };
      }
      if (error instanceof SyntaxError) {
        return { overrides: {}, history: [] };
      }
      throw error;
    }
  }

  private async writeInternal(state: ToolFeedbackState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const normalized = normalizeOverrides(state);
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }
}

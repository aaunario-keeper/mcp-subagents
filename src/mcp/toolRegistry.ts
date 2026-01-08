import { createHash } from 'crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  AgentRole,
  ROLE_TOOL_ACCESS_LEVELS,
  ROLE_TOOL_PERMISSIONS,
  TOOL_ACCESS_LEVEL_ORDER,
  ToolAccessLevel,
} from '../types.js';
import { McpClientManager } from './clientManager.js';

export interface RegisteredTool {
  name: string;
  openAiName: string;
  server: string;
  tool: Tool;
}

export interface ToolDescriptor {
  name: string;
  openAiName: string;
  server: string;
  description: string;
  accessLevel: ToolAccessLevel;
}

export interface RoleToolDescriptor extends ToolDescriptor {
  allowed: boolean;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = `^${escaped.replace(/\*/g, '.*')}$`;
  return new RegExp(regex);
}

function matchesTool(patterns: string[], toolName: string): boolean {
  for (const pattern of patterns) {
    if (pattern === toolName) {
      return true;
    }
    if (pattern.includes('*')) {
      const regex = globToRegExp(pattern);
      if (regex.test(toolName)) {
        return true;
      }
    }
  }
  return false;
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function truncateName(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function buildOpenAiName(server: string, toolName: string): string {
  const base = `${sanitizeToolName(server)}__${sanitizeToolName(toolName)}`.replace(/_+/g, '_');
  return truncateName(base || 'tool', 64);
}

function ensureUniqueName(base: string, canonical: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base;
  }
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  const suffix = `_${hash}`;
  const truncated = truncateName(base, 64 - suffix.length);
  const candidate = `${truncated}${suffix}`;
  if (!used.has(candidate)) {
    return candidate;
  }
  let counter = 1;
  while (counter < 1000) {
    const numberedSuffix = `_${hash}_${counter}`;
    const numbered = `${truncateName(base, 64 - numberedSuffix.length)}${numberedSuffix}`;
    if (!used.has(numbered)) {
      return numbered;
    }
    counter += 1;
  }
  return `${hash}_tool`;
}

const TOOL_LEVEL_PATTERNS: Record<ToolAccessLevel, string[]> = {
  none: [],
  read: [
    '*:read_*',
    '*:list_*',
    '*:find_*',
    '*:grep_*',
    '*:search_*',
    '*:check_*',
    '*:status*',
    '*:syntax_check',
    '*:session_init',
    '*:session_log',
    '*:env_*',
    '*:recent_*',
    '*:read_log',
    '*:tail_*',
    '*:web_search*',
    '*:web_fetch*',
  ],
  write: ['*:create_*', '*:edit_*', '*:write_*', '*:update_*', '*:save_*', '*:apply_*'],
  execute: [
    '*:run_*',
    '*:shell*',
    '*:powershell*',
    '*:execute*',
    '*:start_*',
    '*:wait_*',
  ],
  admin: ['*:delete_*', '*:remove_*', '*:kill_*', '*:reset_*', '*:undo_*', '*:revert_*'],
};

function classifyToolAccess(toolName: string, tool: Tool): ToolAccessLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint) {
    return 'admin';
  }
  if (annotations.readOnlyHint) {
    return 'read';
  }
  if (annotations.openWorldHint) {
    return 'execute';
  }

  if (matchesTool(TOOL_LEVEL_PATTERNS.admin, toolName)) {
    return 'admin';
  }
  if (matchesTool(TOOL_LEVEL_PATTERNS.execute, toolName)) {
    return 'execute';
  }
  if (matchesTool(TOOL_LEVEL_PATTERNS.write, toolName)) {
    return 'write';
  }
  if (matchesTool(TOOL_LEVEL_PATTERNS.read, toolName)) {
    return 'read';
  }

  return 'write';
}

export class ToolRegistry {
  private toolsByCanonical: Map<string, RegisteredTool> = new Map();
  private toolsByOpenAiName: Map<string, RegisteredTool> = new Map();
  private clientManager: McpClientManager;
  private roleAccessLevels: Record<AgentRole, ToolAccessLevel>;
  private accessOverrides: {
    roleLevels: Partial<Record<AgentRole, ToolAccessLevel>>;
    allow: Partial<Record<AgentRole, string[]>>;
    deny: Partial<Record<AgentRole, string[]>>;
  };

  constructor(
    clientManager: McpClientManager,
    options?: { roleAccessLevels?: Record<AgentRole, ToolAccessLevel> },
  ) {
    this.clientManager = clientManager;
    this.roleAccessLevels = options?.roleAccessLevels ?? ROLE_TOOL_ACCESS_LEVELS;
    this.accessOverrides = { roleLevels: {}, allow: {}, deny: {} };
  }

  async refresh(): Promise<void> {
    await this.clientManager.refreshTools();
    const aggregated = this.clientManager.getAllTools();
    this.toolsByCanonical.clear();
    this.toolsByOpenAiName.clear();
    const usedOpenAiNames = new Set<string>();
    for (const [name, entry] of aggregated.entries()) {
      const baseOpenAiName = buildOpenAiName(entry.server, entry.tool.name);
      const openAiName = ensureUniqueName(baseOpenAiName, name, usedOpenAiNames);
      const registered: RegisteredTool = {
        name,
        openAiName,
        server: entry.server,
        tool: entry.tool,
      };
      usedOpenAiNames.add(openAiName);
      this.toolsByCanonical.set(name, registered);
      this.toolsByOpenAiName.set(openAiName, registered);
    }
  }

  hasTools(): boolean {
    return this.toolsByCanonical.size > 0;
  }

  getToolsForRole(role: AgentRole): RegisteredTool[] {
    const patterns = ROLE_TOOL_PERMISSIONS[role] ?? [];
    if (patterns.length === 0) {
      return [];
    }
    const overrideLevel = this.accessOverrides.roleLevels[role];
    const maxLevel = overrideLevel ?? this.roleAccessLevels[role] ?? 'none';
    const maxLevelOrder = TOOL_ACCESS_LEVEL_ORDER[maxLevel] ?? 0;
    const baseTools = Array.from(this.toolsByCanonical.values()).filter(
      (tool) =>
        matchesTool(patterns, tool.name) &&
        TOOL_ACCESS_LEVEL_ORDER[classifyToolAccess(tool.name, tool.tool)] <= maxLevelOrder,
    );

    const allowPatterns = this.accessOverrides.allow[role] ?? [];
    const denyPatterns = this.accessOverrides.deny[role] ?? [];
    const isDenied = (toolName: string) =>
      denyPatterns.length > 0 && matchesTool(denyPatterns, toolName);
    const isAllowed = (toolName: string) =>
      allowPatterns.length > 0 && matchesTool(allowPatterns, toolName);

    const merged = new Map<string, RegisteredTool>();
    for (const tool of baseTools) {
      if (!isDenied(tool.name)) {
        merged.set(tool.name, tool);
      }
    }

    if (allowPatterns.length > 0) {
      for (const tool of this.toolsByCanonical.values()) {
        if (isAllowed(tool.name) && !isDenied(tool.name)) {
          merged.set(tool.name, tool);
        }
      }
    }

    return Array.from(merged.values());
  }

  toOpenAiFunctions(role: AgentRole): object[] {
    return this.getToolsForRole(role).map((entry) => ({
      type: 'function',
      function: {
        name: entry.openAiName,
        description: entry.tool.description ?? entry.tool.title ?? entry.name,
        parameters: entry.tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const registered =
      this.toolsByOpenAiName.get(toolName) ?? this.toolsByCanonical.get(toolName);
    if (!registered) {
      throw new Error(`Tool not registered: ${toolName}`);
    }
    return this.clientManager.callTool(registered.name, args);
  }

  getToolsCatalog(): ToolDescriptor[] {
    return Array.from(this.toolsByCanonical.values())
      .map((entry) => this.describeTool(entry))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getToolsCatalogForRole(role: AgentRole, includeAll = false): RoleToolDescriptor[] {
    const allowed = new Set(this.getToolsForRole(role).map((entry) => entry.name));
    const allTools = this.getToolsCatalog();
    const filtered = includeAll ? allTools : allTools.filter((tool) => allowed.has(tool.name));
    return filtered.map((tool) => ({
      ...tool,
      allowed: allowed.has(tool.name),
    }));
  }

  getEffectiveAccessLevel(role: AgentRole): ToolAccessLevel {
    return this.accessOverrides.roleLevels[role] ?? this.roleAccessLevels[role] ?? 'none';
  }

  resolveToolName(toolName: string): string | null {
    if (this.toolsByCanonical.has(toolName)) {
      return toolName;
    }
    return this.toolsByOpenAiName.get(toolName)?.name ?? null;
  }

  setAccessOverrides(overrides: {
    roleLevels?: Partial<Record<AgentRole, ToolAccessLevel>>;
    allow?: Partial<Record<AgentRole, string[]>>;
    deny?: Partial<Record<AgentRole, string[]>>;
  }): void {
    this.accessOverrides = {
      roleLevels: overrides.roleLevels ?? {},
      allow: overrides.allow ?? {},
      deny: overrides.deny ?? {},
    };
  }

  private describeTool(entry: RegisteredTool): ToolDescriptor {
    return {
      name: entry.name,
      openAiName: entry.openAiName,
      server: entry.server,
      description: entry.tool.description ?? entry.tool.title ?? entry.name,
      accessLevel: classifyToolAccess(entry.name, entry.tool),
    };
  }
}

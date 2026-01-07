# Code Review: mcp-subagents

## Overall Assessment
✅ **Well-structured TypeScript project** with good separation of concerns, proper error handling, and clean abstractions. The code follows modern Node.js patterns and uses the MCP SDK correctly.

---

## 🔴 Critical Issues

### 1. **Missing `tsx` Dependency**
**Location**: `package.json`
**Status**: ✅ **Already present** - `tsx` is correctly listed in `devDependencies`.

### 2. **Race Condition in Memory Store**
**Location**: `src/memory/localMemoryStore.ts:38-43`
**Issue**: `append()` reads, modifies, and writes without locking. Concurrent calls could lose data.
```typescript
async append(sessionId: string, entry: SessionLogEntry): Promise<void> {
  await this.ensureDir();
  const existing = await this.read(sessionId);  // Read
  existing.push(entry);                          // Modify
  const filePath = this.sessionPath(sessionId);
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');  // Write
}
```
**Fix**: Use file locking or atomic write operations. Consider using a simple mutex or `fs.writeFile` with `{ flag: 'wx' }` and retry logic.

### 3. **No Request Timeout in LLM Provider**
**Location**: `src/llm/provider.ts:36`
**Issue**: `fetch()` calls can hang indefinitely if the API is slow/unresponsive.
**Fix**: Add `AbortController` with timeout:
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
try {
  const response = await fetch(url, { ...options, signal: controller.signal });
  clearTimeout(timeoutId);
  // ...
} catch (error) {
  clearTimeout(timeoutId);
  if (error.name === 'AbortError') {
    throw new Error('LLM request timed out');
  }
  throw error;
}
```

---

## 🟡 Important Improvements

### 4. **Config Validation**
**Location**: `src/config.ts`
**Issue**: Numeric environment variables aren't validated. Invalid values (e.g., `AGENT_MAX_DEPTH=abc`) become `NaN`.
**Fix**: Add validation:
```typescript
function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = value ? Number.parseInt(value, 10) : defaultValue;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }
  return parsed;
}

defaultMaxDepth: parsePositiveInt(process.env.AGENT_MAX_DEPTH, 3),
temperature: parseFloat(process.env.AGENT_TEMPERATURE ?? '0.2') || 0.2,
```

### 5. **Better Error Context in JSON Utils**
**Location**: `src/utils/json.ts`
**Issue**: `toJson()` returns empty string on error, losing information.
**Fix**: Log error or throw:
```typescript
export function toJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch (error) {
    console.error('Failed to serialize to JSON:', error);
    throw new Error(`JSON serialization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
```

### 6. **Response Format Handling**
**Location**: `src/server.ts:11-20`
**Issue**: `formatResult()` always stringifies, but MCP SDK may handle structured content better.
**Suggestion**: Consider returning structured content when appropriate:
```typescript
function formatResult(payload: unknown) {
  // If payload is already structured, return as-is
  if (typeof payload === 'object' && payload !== null) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
  return {
    content: [{ type: 'text' as const, text: String(payload) }],
  };
}
```

### 7. **Delegation Limit Documentation**
**Location**: `src/agents/orchestrator.ts:123`
**Issue**: Hard-coded limit of 4 delegations isn't documented or configurable.
**Suggestion**: Make it configurable via env var or document the rationale.

---

## 🟢 Code Quality Suggestions

### 8. **Type Safety Enhancement**
**Location**: `src/llm/provider.ts:50-52`
**Issue**: Type assertion is loose. Consider stricter typing:
```typescript
interface OpenAIResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
  }>;
}
const data = (await response.json()) as OpenAIResponse;
```

### 9. **Add Input Validation**
**Location**: `src/server.ts`
**Issue**: Tool handlers don't validate inputs beyond Zod schema (which is good), but consider validating session_id format.
**Suggestion**: Add session_id format validation or document allowed characters.

### 10. **Error Recovery in Parsing**
**Location**: `src/agents/orchestrator.ts:127-141`
**Issue**: When JSON parsing fails, the fallback loses structure. Consider retry logic or better error messages.
**Suggestion**: Log the raw response when parsing fails for debugging.

### 11. **Memory Store Error Handling**
**Location**: `src/memory/localMemoryStore.ts:25-35`
**Issue**: Only handles `ENOENT`, but other errors (permissions, corruption) aren't handled gracefully.
**Suggestion**: Add more specific error handling:
```typescript
async read(sessionId: string): Promise<SessionLogEntry[]> {
  const filePath = this.sessionPath(sessionId);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as SessionLogEntry[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    if (err instanceof SyntaxError) {
      console.error(`Corrupted session file: ${filePath}`, err);
      return []; // Or attempt recovery
    }
    throw error;
  }
}
```

---

## 📋 Missing Features / Enhancements

### 12. **Environment File Template**
**Status**: ✅ **Created** - `.env.example` file has been added to the project.

### 13. **Package Scripts**
**Location**: `package.json`
**Suggestions**:
- Add `clean` script: `"clean": "rm -rf dist"` (or `rimraf dist` for cross-platform)
- Add `type-check` script: `"type-check": "tsc --noEmit"`
- Consider `prepublishOnly` to ensure build before publish

### 14. **Gitignore**
**Status**: ✅ **Present** - `.gitignore` exists and covers essential files. Consider adding `data/` if session files shouldn't be committed.

### 15. **Logging**
**Location**: Throughout
**Issue**: Uses `console.error` directly. Consider a logging library or at least structured logging.
**Suggestion**: Use a lightweight logger like `pino` or create a simple logger interface.

### 16. **Testing**
**Missing**: No test files
**Suggestion**: Add unit tests for:
- JSON parsing utilities
- Memory store operations
- Config validation
- Orchestrator delegation logic

### 17. **Documentation**
**Location**: Code comments
**Suggestion**: Add JSDoc comments for public APIs:
```typescript
/**
 * Orchestrates agent execution with recursive delegation support.
 * 
 * @param request - Agent request with role, objective, and optional context
 * @returns Promise resolving to agent result with summary and child results
 */
async run(request: AgentRequest): Promise<AgentResult> {
  // ...
}
```

---

## ✅ What's Done Well

1. **Type Safety**: Good use of TypeScript with strict mode
2. **Error Handling**: Proper try-catch blocks and error propagation
3. **Abstraction**: Clean separation between provider, memory, and orchestrator
4. **Session Management**: Good session isolation and persistence
5. **Depth Limiting**: Prevents infinite recursion
6. **Zod Validation**: Proper input validation with Zod schemas
7. **Modular Structure**: Well-organized file structure

---

## 🔧 Quick Wins (Priority Order)

1. ✅ **`.gitignore`** - Already present
2. ⚠️ **`.env.example`** - Should be created manually (blocked by gitignore, but can be added to repo)
3. ✅ **`tsx` dependency** - Already correct
4. **Add timeout to LLM provider** (10 min) - **HIGH PRIORITY**
5. **Add config validation** (15 min) - **HIGH PRIORITY**
6. **Fix race condition in memory store** (30 min) - **CRITICAL**
7. **Add error recovery for corrupted session files** (15 min)

---

## 📊 Code Metrics

- **Total Files**: 9 TypeScript files
- **Lines of Code**: ~400 LOC
- **Complexity**: Low-Medium (recursive delegation adds some complexity)
- **Test Coverage**: 0% (no tests found)
- **Dependencies**: Minimal and well-chosen

---

## 🎯 Recommendations Summary

**Must Fix**:
- Race condition in memory store
- Missing request timeout
- Config validation

**Should Fix**:
- Better error handling
- Add `.gitignore` and `.env.example`
- Improve logging

**Nice to Have**:
- Unit tests
- JSDoc comments
- Configurable delegation limits
- Structured logging


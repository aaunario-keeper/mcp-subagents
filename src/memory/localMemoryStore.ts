import fs from 'fs/promises';
import path from 'path';
import { SessionLogEntry } from '../types.js';

/**
 * Sanitize session ID to be filesystem-safe.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

/**
 * Simple async mutex for preventing concurrent access to the same resource.
 */
class AsyncMutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Execute a function with exclusive access to the given key.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create our lock
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(key, promise);

    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      resolve!();
    }
  }
}

/**
 * File-based session memory store with JSON persistence.
 * Thread-safe for concurrent access within the same process.
 */
export class LocalHybridMemoryStore {
  private baseDir: string;
  private mutex = new AsyncMutex();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private sessionPath(sessionId: string): string {
    const safe = sanitizeSessionId(sessionId);
    return path.join(this.baseDir, `${safe}.json`);
  }

  /**
   * Read all log entries for a session.
   * Returns an empty array if the session doesn't exist or the file is corrupted.
   *
   * @param sessionId - Session identifier
   * @returns Array of session log entries
   */
  async read(sessionId: string): Promise<SessionLogEntry[]> {
    const filePath = this.sessionPath(sessionId);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);

      // Validate it's an array
      if (!Array.isArray(parsed)) {
        console.error(`Session file is not an array: ${filePath}`);
        return [];
      }

      return parsed as SessionLogEntry[];
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      // File doesn't exist - that's fine, return empty
      if (err.code === 'ENOENT') {
        return [];
      }

      // JSON parse error - file is corrupted
      if (error instanceof SyntaxError) {
        console.error(`Corrupted session file, resetting: ${filePath}`, error.message);
        // Backup the corrupted file for debugging
        try {
          await fs.rename(filePath, `${filePath}.corrupted.${Date.now()}`);
        } catch {
          // Ignore backup failure
        }
        return [];
      }

      throw error;
    }
  }

  /**
   * Append a log entry to a session.
   * Thread-safe: uses mutex to prevent concurrent writes from losing data.
   *
   * @param sessionId - Session identifier
   * @param entry - Log entry to append
   */
  async append(sessionId: string, entry: SessionLogEntry): Promise<void> {
    await this.mutex.withLock(sessionId, async () => {
      await this.ensureDir();
      const existing = await this.read(sessionId);
      existing.push(entry);
      const filePath = this.sessionPath(sessionId);
      await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');
    });
  }

  /**
   * Clear all log entries for a session by deleting the file.
   *
   * @param sessionId - Session identifier
   */
  async clear(sessionId: string): Promise<void> {
    await this.mutex.withLock(sessionId, async () => {
      const filePath = this.sessionPath(sessionId);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }
}

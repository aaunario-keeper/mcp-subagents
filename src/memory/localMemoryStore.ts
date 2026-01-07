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
 * Uses a queue-based approach to ensure FIFO ordering and true mutual exclusion.
 */
class AsyncMutex {
  private queues = new Map<string, Array<() => void>>();
  private held = new Set<string>();

  /**
   * Execute a function with exclusive access to the given key.
   * Callers are queued and executed in FIFO order.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // If lock is held, wait in queue
    if (this.held.has(key)) {
      await new Promise<void>((resolve) => {
        let queue = this.queues.get(key);
        if (!queue) {
          queue = [];
          this.queues.set(key, queue);
        }
        queue.push(resolve);
      });
    }

    // Acquire lock
    this.held.add(key);

    try {
      return await fn();
    } finally {
      // Release lock and wake next waiter
      this.held.delete(key);
      const queue = this.queues.get(key);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) {
          this.queues.delete(key);
        }
        // Mark as held before waking to prevent race
        this.held.add(key);
        next();
      }
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
   * Internal read implementation (not protected by mutex).
   * Use read() for external calls.
   */
  private async readInternal(sessionId: string): Promise<SessionLogEntry[]> {
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
   * Read all log entries for a session.
   * Thread-safe: uses mutex to prevent reading during concurrent writes.
   * Returns an empty array if the session doesn't exist or the file is corrupted.
   *
   * @param sessionId - Session identifier
   * @returns Array of session log entries
   */
  async read(sessionId: string): Promise<SessionLogEntry[]> {
    return this.mutex.withLock(sessionId, () => this.readInternal(sessionId));
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
      const existing = await this.readInternal(sessionId);
      existing.push(entry);
      const filePath = this.sessionPath(sessionId);
      await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');
    });
  }

  /**
   * Clear all log entries for a session by deleting the file.
   * Thread-safe: uses mutex to prevent clearing during concurrent access.
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

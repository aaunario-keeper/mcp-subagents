/**
 * Safely parse a JSON string, returning null on failure.
 *
 * @param input - JSON string to parse
 * @returns Parsed value or null if parsing fails
 */
export function safeParseJson<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

/**
 * Serialize a value to a JSON string with formatting.
 * Throws an error if serialization fails (e.g., circular references).
 *
 * @param input - Value to serialize
 * @returns JSON string
 * @throws Error if serialization fails
 */
export function toJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`JSON serialization failed: ${message}`);
  }
}

/**
 * Serialize a value to JSON, with a fallback for errors.
 * Use this when you need a best-effort serialization without throwing.
 *
 * @param input - Value to serialize
 * @param fallback - Fallback string if serialization fails
 * @returns JSON string or fallback
 */
export function toJsonSafe(input: unknown, fallback = '{}'): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return fallback;
  }
}

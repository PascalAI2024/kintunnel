import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Append-only NDJSON audit log with size-based rotation.
 *
 * Layout under `logDir`:
 *   audit.log                       # current, always written via O_APPEND
 *   audit.log.2026-06-29T15-30-00Z  # rotated; timestamp uses RFC3339 with `:` → `-`
 *
 * Rotation triggers when `audit.log` exceeds `maxBytes` after an append.
 * Retention is enforced on each rotation: rotated files beyond
 * `retentionCount` are unlinked in chronological order (oldest first).
 *
 * Appends never throw — a failed write is logged and swallowed so the
 * engine never crashes because of audit persistence. Query and rotate
 * propagate errors because they are operator-initiated and rare.
 */
export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  query(filter: {
    action?: string;
    actor?: string;
    since?: string;
    limit?: number;
  }): Promise<AuditEvent[]>;
  rotate(): Promise<{ rotated: boolean; reason: string }>;
  flush(): Promise<void>;
}

export interface AuditStoreConfig {
  logDir: string;
  maxBytes: number;
  retentionCount: number;
  logger: Logger;
}

const ROTATION_PREFIX = "audit.log.";

export async function createAuditStore(config: AuditStoreConfig): Promise<AuditStore> {
  await fs.mkdir(config.logDir, { recursive: true });
  const store = new AuditStoreImpl(config);
  return store;
}

class AuditStoreImpl implements AuditStore {
  private readonly logDir: string;
  private readonly maxBytes: number;
  private readonly retentionCount: number;
  private readonly logger: Logger;
  private readonly currentPath: string;
  private handle: import("node:fs/promises").FileHandle | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: AuditStoreConfig) {
    this.logDir = config.logDir;
    this.maxBytes = config.maxBytes;
    this.retentionCount = config.retentionCount;
    this.logger = config.logger;
    this.currentPath = path.join(this.logDir, "audit.log");
  }

  async append(event: AuditEvent): Promise<void> {
    // Serialize writes so fsync order matches logical order. Appends swallow
    // errors per spec; rotation errors are also swallowed inside the queue.
    const next = this.writeQueue.then(() =>
      this.doAppend(event).catch((error: unknown) => {
        this.logger.warn("audit append failed", {
          error: error instanceof Error ? error.message : String(error),
          action: event.action
        });
      })
    );
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async query(filter: {
    action?: string;
    actor?: string;
    since?: string;
    limit?: number;
  }): Promise<AuditEvent[]> {
    const requestedLimit = filter.limit ?? 1000;
    const limit = Math.min(Math.max(requestedLimit, 1), 5000);

    const sinceTime = filter.since ? Date.parse(filter.since) : NaN;
    const sinceValid = Number.isFinite(sinceTime);

    const entries = await fs.readdir(this.logDir);
    // Oldest first so we walk files in chronological order; newest entries
    // are sorted within the merged array later.
    const files = entries
      .filter((name) => name === "audit.log" || name.startsWith(ROTATION_PREFIX))
      .sort();

    const merged: AuditEvent[] = [];
    for (const filename of files) {
      const filepath = path.join(this.logDir, filename);
      let content: string;
      try {
        content = await fs.readFile(filepath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const rawLine of content.split("\n")) {
        if (rawLine.length === 0) continue;
        try {
          const event = JSON.parse(rawLine) as AuditEvent;
          merged.push(event);
        } catch {
          // Skip malformed lines silently — a partial line at rotation time
          // is recoverable; the next rotation will rename and start fresh.
        }
      }
    }

    const filtered = merged.filter((event) => {
      if (filter.action && event.action !== filter.action) return false;
      if (filter.actor && event.actor !== filter.actor) return false;
      if (sinceValid) {
        const eventTime = Date.parse(event.createdAt);
        if (!Number.isFinite(eventTime) || eventTime < sinceTime) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      return bTime - aTime;
    });

    return filtered.slice(0, limit);
  }

  async rotate(): Promise<{ rotated: boolean; reason: string }> {
    // Wait for the in-flight write chain so the size we read is stable.
    await this.writeQueue;
    if (!this.handle) {
      return { rotated: false, reason: "no_active_handle" };
    }
    const stats = await this.handle.stat();
    if (stats.size <= this.maxBytes) {
      return { rotated: false, reason: "below_threshold" };
    }
    await this.doRotate("manual");
    return { rotated: true, reason: "size_exceeded" };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
    if (this.handle) {
      await this.handle.sync();
    }
  }

  private async doAppend(event: AuditEvent): Promise<void> {
    if (!this.handle) {
      this.handle = await fs.open(this.currentPath, "a");
    }
    const line = `${JSON.stringify(event)}\n`;
    await this.handle.write(line);
    await this.handle.sync();

    const stats = await this.handle.stat();
    if (stats.size > this.maxBytes) {
      await this.doRotate("size_exceeded");
    }
  }

  private async doRotate(reason: string): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }

    // RFC3339 timestamp with `:` replaced by `-` for filesystem safety.
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const rotatedPath = path.join(this.logDir, `${ROTATION_PREFIX}${timestamp}`);

    // If the current file does not exist (e.g. nothing was ever appended),
    // there's nothing to rotate. Just leave audit.log missing; the next
    // append will create it.
    try {
      await fs.rename(this.currentPath, rotatedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return;
    }

    await this.pruneOldFiles();
    this.logger.info("audit log rotated", {
      reason,
      rotated_to: rotatedPath,
      current: this.currentPath
    });
  }

  private async pruneOldFiles(): Promise<void> {
    const entries = await fs.readdir(this.logDir);
    const rotated = entries
      .filter((name) => name.startsWith(ROTATION_PREFIX))
      .sort();
    // Newest first; keep the first retentionCount, delete the rest.
    rotated.reverse();
    const toDelete = rotated.slice(this.retentionCount);
    for (const name of toDelete) {
      const filepath = path.join(this.logDir, name);
      await fs.unlink(filepath).catch((error: unknown) => {
        this.logger.warn("audit log prune failed", {
          file: name,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }
}
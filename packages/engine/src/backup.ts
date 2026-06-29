import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { atomicWriteFile, withFileLock } from "./state.js";
import type { StateStore } from "./state.js";
import pkg from "../../../package.json" with { type: "json" };
import type {
  BackupManifest,
  BackupRestorePlan,
  BackupRestoreRequest,
  BackupSummary,
  EngineConfig,
  EngineState,
  PeerRecord
} from "./types.js";

const KINTUNNEL_VERSION: string = pkg.version;

const execFileAsync = promisify(execFile);

export type BackupErrorCode =
  | "checksum_mismatch"
  | "snapshot_not_found"
  | "refused_recent"
  | "lock_timeout"
  | "io_error"
  | "import_invalid";

export class BackupError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupStorage {
  backupCreate(req: { trigger: BackupManifest["trigger"]; actor: string }): Promise<BackupSummary>;
  backupList(): Promise<BackupSummary[]>;
  backupRestore(
    req: BackupRestoreRequest,
    actor: string
  ): Promise<{
    ok: boolean;
    safetySnapshotId?: string;
    fromRevision?: number;
    applied: boolean;
    error?: string;
  }>;
  backupRestorePlan(snapshotId: string): Promise<BackupRestorePlan>;
  backupExport(snapshotId: string): Promise<{
    stream: NodeJS.ReadableStream;
    sizeBytes: number;
    contentType: string;
  }>;
  backupImport(stream: NodeJS.ReadableStream, source: "upload"): Promise<BackupSummary>;
  backupDelete(snapshotId: string): Promise<{ snapshotId: string; sizeBytes: number }>;
}

interface RetentionState {
  last_prune_at: string;
  kept: number;
}

interface PruneResult {
  kept: number;
  deleted: Array<{ id: string }>;
}

export function createBackupStorage(config: EngineConfig, store: StateStore): BackupStorage {
  const backupDir = config.backupDir;
  const lockPath = path.join(backupDir, ".lock");
  const retentionPath = path.join(backupDir, ".retention");
  const tmpDir = path.join(backupDir, "tmp");
  const exportsDir = path.join(backupDir, "exports");

  function sha256(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  function randomHex(bytes: number): string {
    return randomBytes(bytes).toString("hex");
  }

  function snapshotDir(id: string): string {
    return path.join(backupDir, `snap-${id}`);
  }

  async function ensureBackupDirs(): Promise<void> {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(exportsDir, { recursive: true });
  }

  async function readSnapshotManifest(snapshotId: string): Promise<BackupManifest> {
    const manifestPath = path.join(snapshotDir(snapshotId), "manifest.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackupError("snapshot_not_found", `Snapshot not found: ${snapshotId}`);
      }
      throw new BackupError("io_error", `Failed to read manifest: ${(error as Error).message}`);
    }
    try {
      return JSON.parse(raw) as BackupManifest;
    } catch (error) {
      throw new BackupError("io_error", `Manifest is not valid JSON: ${(error as Error).message}`);
    }
  }

  async function readSnapshotStateBytes(snapshotId: string): Promise<{ bytes: Buffer; sha: string }> {
    const statePath = path.join(snapshotDir(snapshotId), "state.json");
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackupError("snapshot_not_found", `Snapshot state missing: ${snapshotId}`);
      }
      throw new BackupError("io_error", `Failed to read state.json: ${(error as Error).message}`);
    }
    return { bytes, sha: sha256(bytes) };
  }

  async function buildSnapshotSummary(
    snapshotId: string,
    manifest: BackupManifest | null
  ): Promise<BackupSummary> {
    const dir = snapshotDir(snapshotId);
    const manifestBytes = await fs.readFile(path.join(dir, "manifest.json")).catch(() => null);
    const stateBytes = await fs.readFile(path.join(dir, "state.json")).catch(() => null);
    if (!manifestBytes || !stateBytes) {
      throw new BackupError("snapshot_not_found", `Snapshot incomplete: ${snapshotId}`);
    }
    const sizeBytes = manifestBytes.length + stateBytes.length;
    const stateSha = sha256(stateBytes);
    let parsedManifest: BackupManifest | null = manifest;
    if (!parsedManifest) {
      try {
        parsedManifest = JSON.parse(manifestBytes.toString("utf8")) as BackupManifest;
      } catch {
        return {
          snapshot_id: snapshotId,
          created_at: new Date(0).toISOString(),
          engine_revision: 0,
          trigger: "manual",
          size_bytes: sizeBytes,
          file_count: 0,
          corrupt: true
        };
      }
    }
    const manifestSha = parsedManifest.files[0]?.sha256;
    const corrupt = !manifestSha || manifestSha !== stateSha;
    return {
      snapshot_id: snapshotId,
      created_at: parsedManifest.created_at,
      engine_revision: parsedManifest.engine_revision,
      trigger: parsedManifest.trigger,
      size_bytes: sizeBytes,
      file_count: parsedManifest.files.length,
      corrupt
    };
  }

  /**
   * Build the canonical snapshot files (manifest + state.json) inside a
   * staging directory and atomically rename into place. Caller must hold
   * the backup lock. The bytes written to state.json are exactly the bytes
   * whose SHA-256 is embedded in `manifest.files[0].sha256` — pre-computed
   * so we never have to rewrite the manifest.
   */
  async function writeSnapshotToStaging(opts: {
    snapshotId: string;
    state: EngineState;
    trigger: BackupManifest["trigger"];
  }): Promise<{ manifest: BackupManifest; manifestPath: string; statePath: string; canonicalDir: string }> {
    const stateJson = `${JSON.stringify(opts.state, null, 2)}\n`;
    const stateBytes = Buffer.from(stateJson, "utf8");
    const stateSha = sha256(stateBytes);

    const manifest: BackupManifest = {
      kintunnel_version: KINTUNNEL_VERSION,
      format_version: 1,
      schema_version: 1,
      snapshot_id: opts.snapshotId,
      engine_revision: opts.state.revision,
      created_at: new Date().toISOString(),
      trigger: opts.trigger,
      interface: {
        name: opts.state.server.interfaceName,
        listen_port: opts.state.server.listenPort,
        public_key: opts.state.server.serverPublicKey,
        tunnel_cidr_v4: opts.state.server.tunnelCidrV4
      },
      files: [{ path: "state.json", size_bytes: stateBytes.length, sha256: stateSha }],
      compatibility: {
        min_engine_version: KINTUNNEL_VERSION
      },
      encrypted: false,
      retention: {
        policy: "count",
        kept_after_prune: config.backupRetentionCount
      }
    };

    const stagingDir = path.join(tmpDir, `snap-${opts.snapshotId}.${randomHex(4)}.staging`);
    const canonicalDir = snapshotDir(opts.snapshotId);
    const manifestPath = path.join(stagingDir, "manifest.json");
    const statePath = path.join(stagingDir, "state.json");

    await fs.mkdir(stagingDir, { recursive: true });
    await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    await atomicWriteFile(statePath, stateBytes);
    await fs.rename(stagingDir, canonicalDir);

    return { manifest, manifestPath: path.join(canonicalDir, "manifest.json"), statePath: path.join(canonicalDir, "state.json"), canonicalDir };
  }

  /**
   * Count-based retention pruner. Lists `snap-*` directories, sorts by mtime
   * descending, keeps the top `config.backupRetentionCount`, and removes the
   * rest. Corrupt snapshots are kept (they appear in `list()` with
   * `corrupt: true`) and never deleted by retention.
   */
  async function pruneOldSnapshots(): Promise<PruneResult> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(backupDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kept: 0, deleted: [] };
      }
      throw error;
    }

    const candidates: Array<{ id: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("snap-")) continue;
      const id = entry.name.slice("snap-".length);
      try {
        const stat = await fs.stat(path.join(backupDir, entry.name));
        candidates.push({ id, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore unreadable entries
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const keep = candidates.slice(0, config.backupRetentionCount);
    const drop = candidates.slice(config.backupRetentionCount);
    const deleted: Array<{ id: string }> = [];

    for (const snap of drop) {
      try {
        await fs.rm(snapshotDir(snap.id), { recursive: true, force: true });
        deleted.push({ id: snap.id });
      } catch {
        // best-effort
      }
    }

    const retentionState: RetentionState = {
      last_prune_at: new Date().toISOString(),
      kept: keep.length
    };
    try {
      await atomicWriteFile(retentionPath, JSON.stringify(retentionState, null, 2));
    } catch {
      // best-effort
    }

    return { kept: keep.length, deleted };
  }

  /**
   * Internal snapshot creator. Performs the file ops without taking the
   * backup lock — the caller (backupCreate or backupRestore's safety branch)
   * is responsible for lock discipline.
   */
  async function snapshotInternal(opts: {
    trigger: BackupManifest["trigger"];
    actor: string;
  }): Promise<BackupSummary> {
    await ensureBackupDirs();
    const state = await store.load();
    const snapshotId = randomUUID();
    const { manifest } = await writeSnapshotToStaging({
      snapshotId,
      state,
      trigger: opts.trigger
    });
    return buildSnapshotSummary(snapshotId, manifest);
  }

  async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withFileLock(lockPath, fn, { timeoutMs: config.backupLockTimeoutMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKTIMEOUT") {
        throw new BackupError(
          "lock_timeout",
          `Timed out acquiring backup lock after ${config.backupLockTimeoutMs}ms`
        );
      }
      throw error;
    }
  }

  async function peersEqual(a: PeerRecord, b: PeerRecord): Promise<boolean> {
    if (a.allowedIps.join(",") !== b.allowedIps.join(",")) return false;
    if (a.dnsServers.join(",") !== b.dnsServers.join(",")) return false;
    if (a.persistentKeepalive !== b.persistentKeepalive) return false;
    if (a.status !== b.status) return false;
    if ((a.expiresAt ?? "") !== (b.expiresAt ?? "")) return false;
    if (a.name !== b.name) return false;
    if (a.addressV4 !== b.addressV4) return false;
    return true;
  }

  async function computePeerDiff(
    snapshotState: EngineState,
    currentState: EngineState
  ): Promise<{ added: string[]; removed: string[]; modified: string[]; affected: string[] }> {
    const snapshotPeers = snapshotState.peers.filter((peer) => peer.status !== "deleted");
    const currentPeers = currentState.peers.filter((peer) => peer.status !== "deleted");
    const snapshotByKey = new Map(snapshotPeers.map((peer) => [peer.publicKey, peer]));
    const currentByKey = new Map(currentPeers.map((peer) => [peer.publicKey, peer]));

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const affectedSet = new Set<string>();

    for (const [key, peer] of snapshotByKey) {
      affectedSet.add(key);
      const inCurrent = currentByKey.get(key);
      if (!inCurrent) {
        added.push(key);
      } else if (!(await peersEqual(peer, inCurrent))) {
        modified.push(key);
      }
    }
    for (const key of currentByKey.keys()) {
      if (!snapshotByKey.has(key)) {
        removed.push(key);
        affectedSet.add(key);
      }
    }

    return { added, removed, modified, affected: Array.from(affectedSet) };
  }

  return {
    async backupCreate(req) {
      await ensureBackupDirs();
      return withBackupLock(async () => {
        const summary = await snapshotInternal({ trigger: req.trigger, actor: req.actor });
        const pruneResult = await pruneOldSnapshots();

        await store.update(async (state) => {
          store.appendEvent(state, {
            action: "backup.created",
            actor: req.actor,
            targetId: summary.snapshot_id,
            metadata: {
              snapshot_id: summary.snapshot_id,
              revision: summary.engine_revision,
              size_bytes: summary.size_bytes,
              file_count: summary.file_count,
              trigger: summary.trigger
            }
          });
          for (const deleted of pruneResult.deleted) {
            store.appendEvent(state, {
              action: "backup.pruned",
              targetId: deleted.id,
              metadata: {
                snapshot_id: deleted.id,
                kept: pruneResult.kept
              }
            });
          }
        });

        return summary;
      });
    },

    async backupList() {
      await ensureBackupDirs();
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(backupDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const summaries: BackupSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("snap-")) continue;
        const id = entry.name.slice("snap-".length);
        try {
          summaries.push(await buildSnapshotSummary(id, null));
        } catch {
          // Skip unreadable entries
        }
      }
      summaries.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return summaries;
    },

    async backupRestore(req, actor) {
      await ensureBackupDirs();
      return withBackupLock(async () => {
        const manifest = await readSnapshotManifest(req.snapshot_id);
        const { bytes: stateBytes, sha: actualSha } = await readSnapshotStateBytes(req.snapshot_id);
        const expectedSha = manifest.files[0]?.sha256;
        if (!expectedSha || expectedSha !== actualSha) {
          throw new BackupError(
            "checksum_mismatch",
            `Snapshot ${req.snapshot_id} failed checksum verification (expected ${expectedSha ?? "<unset>"}, got ${actualSha})`
          );
        }

        let safetySnapshotId: string | undefined;
        if (!req.force) {
          const safety = await snapshotInternal({ trigger: "pre-rotate", actor });
          safetySnapshotId = safety.snapshot_id;
        }

        let applied = false;
        let fromRevision: number | undefined;
        let errorMessage: string | undefined;

        try {
          if (req.apply) {
            const currentState = await store.load();
            fromRevision = currentState.revision;

            // Stop WireGuard best-effort. We swallow non-zero exit codes so
            // restore still proceeds even when wg-quick isn't installed or
            // the interface is already down.
            await execFileAsync("wg-quick", ["down", config.interfaceName]).catch(() => undefined);

            await atomicWriteFile(config.statePath, stateBytes);
            applied = true;

            const restoredState = await store.load();
            store.appendEvent(restoredState, {
              action: "backup.restored",
              actor,
              targetId: req.snapshot_id,
              metadata: {
                snapshot_id: req.snapshot_id,
                from_revision: fromRevision,
                safety_snapshot_id: safetySnapshotId ?? null,
                applied: true
              }
            });
            await store.save(restoredState);
          }

          return {
            ok: applied,
            applied,
            safetySnapshotId,
            fromRevision,
            error: undefined
          };
        } catch (err) {
          errorMessage = (err as Error).message;

          // Attempt to recover by restoring from the safety snapshot. Best-effort.
          if (safetySnapshotId) {
            try {
              const safetyState = await readSnapshotStateBytes(safetySnapshotId);
              await atomicWriteFile(config.statePath, safetyState.bytes);
              const afterRecovery = await store.load();
              store.appendEvent(afterRecovery, {
                action: "backup.restore.failed",
                actor,
                targetId: req.snapshot_id,
                metadata: {
                  snapshot_id: req.snapshot_id,
                  error_code: "restore_failed",
                  error_message: errorMessage,
                  safety_snapshot_id: safetySnapshotId
                }
              });
              await store.save(afterRecovery);
            } catch {
              // Recovery itself failed — surface the original error.
            }
          }
          throw err;
        }
      });
    },

    async backupRestorePlan(snapshotId) {
      const manifest = await readSnapshotManifest(snapshotId);
      const { bytes, sha } = await readSnapshotStateBytes(snapshotId);
      const expectedSha = manifest.files[0]?.sha256;
      if (!expectedSha || expectedSha !== sha) {
        throw new BackupError("checksum_mismatch", `Snapshot ${snapshotId} is corrupt`);
      }
      const snapshotState = JSON.parse(bytes.toString("utf8")) as EngineState;
      const currentState = await store.load();
      const diff = await computePeerDiff(snapshotState, currentState);

      const warnings: string[] = [];
      const applyBlockedReasons: string[] = [];

      if (
        manifest.compatibility.min_engine_version &&
        manifest.compatibility.min_engine_version !== KINTUNNEL_VERSION
      ) {
        warnings.push(
          `Snapshot was created with engine ${manifest.compatibility.min_engine_version}; current is ${KINTUNNEL_VERSION}`
        );
      }
      if (manifest.compatibility.max_engine_version && manifest.compatibility.max_engine_version < KINTUNNEL_VERSION) {
        applyBlockedReasons.push(
          `Snapshot requires engine <= ${manifest.compatibility.max_engine_version}; current is ${KINTUNNEL_VERSION}`
        );
      }

      return {
        snapshot_id: snapshotId,
        from_revision: manifest.engine_revision,
        to_revision: currentState.revision,
        peer_changes: {
          added: diff.added,
          removed: diff.removed,
          modified: diff.modified
        },
        affected_public_keys: diff.affected,
        warnings,
        apply_blocked_reasons: applyBlockedReasons
      };
    },

    async backupExport(snapshotId) {
      const manifest = await readSnapshotManifest(snapshotId);
      const { bytes, sha } = await readSnapshotStateBytes(snapshotId);
      const expectedSha = manifest.files[0]?.sha256;
      if (!expectedSha || expectedSha !== sha) {
        throw new BackupError("checksum_mismatch", `Snapshot ${snapshotId} is corrupt`);
      }
      const snapshotState = JSON.parse(bytes.toString("utf8")) as EngineState;
      const wrapper = JSON.stringify(
        {
          wrapper_format: "kintunnel-backup-v1",
          manifest,
          state: snapshotState
        },
        null,
        2
      );
      const buffer = Buffer.from(wrapper, "utf8");
      return {
        stream: Readable.from(buffer),
        sizeBytes: buffer.length,
        contentType: "application/json"
      };
    },

    async backupImport(stream, source) {
      await ensureBackupDirs();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: { wrapper_format?: string; manifest?: BackupManifest; state?: EngineState };
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new BackupError("import_invalid", `Import payload is not valid JSON: ${(error as Error).message}`);
      }
      if (parsed.wrapper_format !== "kintunnel-backup-v1" || !parsed.manifest || !parsed.state) {
        throw new BackupError(
          "import_invalid",
          "Import payload is missing wrapper_format/manifest/state fields"
        );
      }
      const stateBytes = Buffer.from(`${JSON.stringify(parsed.state, null, 2)}\n`, "utf8");
      const actualSha = sha256(stateBytes);
      const expectedSha = parsed.manifest.files[0]?.sha256;
      if (!expectedSha || expectedSha !== actualSha) {
        throw new BackupError(
          "checksum_mismatch",
          `Imported snapshot failed checksum verification (expected ${expectedSha ?? "<unset>"}, got ${actualSha})`
        );
      }

      return withBackupLock(async () => {
        const snapshotId = randomUUID();
        const stagedState = { ...parsed.state!, snapshot_id_override: undefined } as EngineState;
        // Rebuild manifest with the new snapshot id; reuse the imported metadata
        // except for fields that must reflect the imported bytes.
        const manifest: BackupManifest = {
          ...parsed.manifest!,
          snapshot_id: snapshotId,
          files: [{ path: "state.json", size_bytes: stateBytes.length, sha256: actualSha }]
        };

        const stagingDir = path.join(tmpDir, `snap-${snapshotId}.${randomHex(4)}.staging`);
        const canonicalDir = snapshotDir(snapshotId);
        await fs.mkdir(stagingDir, { recursive: true });
        await atomicWriteFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        await atomicWriteFile(path.join(stagingDir, "state.json"), stateBytes);
        await fs.rename(stagingDir, canonicalDir);

        const summary = await buildSnapshotSummary(snapshotId, manifest);

        await store.update(async (state) => {
          store.appendEvent(state, {
            action: "backup.imported",
            targetId: snapshotId,
            metadata: {
              snapshot_id: snapshotId,
              source
            }
          });
        });

        return summary;
      });
    },

    async backupDelete(snapshotId) {
      await ensureBackupDirs();
      return withBackupLock(async () => {
        const manifest = await readSnapshotManifest(snapshotId).catch(() => null);
        if (!manifest) {
          throw new BackupError("snapshot_not_found", `Snapshot not found: ${snapshotId}`);
        }
        const summaries = await Promise.resolve().then(async () => {
          let entries: import("node:fs").Dirent[];
          try {
            entries = await fs.readdir(backupDir, { withFileTypes: true });
          } catch {
            return [] as BackupSummary[];
          }
          const all: BackupSummary[] = [];
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith("snap-")) continue;
            const id = entry.name.slice("snap-".length);
            try {
              all.push(await buildSnapshotSummary(id, null));
            } catch {
              // ignore
            }
          }
          all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          return all;
        });
        if (summaries[0]?.snapshot_id === snapshotId) {
          throw new BackupError(
            "refused_recent",
            `Refusing to delete most recent snapshot ${snapshotId}; create a newer one first`
          );
        }

        const manifestBytes = await fs.readFile(path.join(snapshotDir(snapshotId), "manifest.json")).catch(() => null);
        const stateBytes = await fs.readFile(path.join(snapshotDir(snapshotId), "state.json")).catch(() => null);
        const sizeBytes = (manifestBytes?.length ?? 0) + (stateBytes?.length ?? 0);

        await fs.rm(snapshotDir(snapshotId), { recursive: true, force: true });

        await store.update(async (state) => {
          store.appendEvent(state, {
            action: "backup.deleted",
            targetId: snapshotId,
            metadata: {
              snapshot_id: snapshotId,
              size_bytes: sizeBytes
            }
          });
        });

        return { snapshotId, sizeBytes };
      });
    }
  };
}
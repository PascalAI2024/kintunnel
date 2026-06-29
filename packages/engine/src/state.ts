import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { allocatePeerAddress, parseIpv4Cidr, numberToIpv4 } from "./ip.js";
import { generateKeyPair } from "./keys.js";
import {
  UNASSIGNED_PERSON_ID,
  validateAllowedIp,
  validateDeviceLabel,
  validateDnsServer,
  validateExpiresAt,
  validatePeerName,
  validatePersonId,
  validatePersonName,
  validatePersonNotes,
  validateWireGuardKey
} from "./peers.js";
import type { AuditSink } from "./audit-store.js";
import type {
  AuditAction,
  AuditEvent,
  EngineConfig,
  EngineState,
  PeerRecord,
  PersonRecord,
  PersonStatus
} from "./types.js";

const MAX_AUDIT_EVENTS = 250;
const FILE_MODE_PRIVATE = 0o600;

/**
 * Reusable atomic write: write to a uniquely-named temp file in the same
 * directory, then `rename(2)` over the target. POSIX `rename` is atomic on
 * the same filesystem, so readers either see the previous content or the new
 * content — never a half-written file.
 *
 * Used by `StateStore.save` and by the backup module's snapshot writer
 * (Wave 4). Throws if the parent directory cannot be created or if the
 * rename fails; partial writes are cleaned up implicitly because the temp
 * file name is unique per call.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  options: { mode?: number; encoding?: BufferEncoding } = {}
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(targetPath);
  const tempPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.tmp`
  );
  try {
    await fs.writeFile(tempPath, content, {
      encoding: (options.encoding ?? "utf8") as BufferEncoding,
      mode: options.mode ?? FILE_MODE_PRIVATE
    });
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    // Best-effort cleanup: if the temp file exists and rename failed, unlink it.
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Acquire a BSD-style advisory file lock around `fn`. The lock is keyed by
 * the lockPath file — multiple processes contending for the same path will
 * serialize. Different lockPaths are independent. Implemented via
 * `FileHandle#flock` (Node >= 22). The lock is released when the returned
 * promise settles (success or failure) by closing the underlying fd.
 *
 * NOTE: `flock` is acquired by the calling process; concurrent calls with
 * the same path from the same process block on each other as expected.
 * The `timeoutMs` bounds the wait via a race; if it fires we throw with
 * `code = "ELOCKTIMEOUT"` and release. Callers (e.g. backup.ts) should
 * map that to HTTP 409.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs: number }
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = await fs.open(lockPath, "w");
  try {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(
          `Timed out acquiring file lock at ${lockPath} after ${options.timeoutMs}ms`
        );
        (err as NodeJS.ErrnoException).code = "ELOCKTIMEOUT";
        reject(err);
      }, options.timeoutMs);
    });
    const acquire = (async () => {
      // `FileHandle#flock` is added in Node 22.0.0. The runtime is locked
      // to >=22 (see root package.json `engines.node`), so this call is
      // safe at runtime; the @types/node version in devDeps may not yet
      // declare the method, hence the narrow cast.
      await (fd as unknown as { flock(): Promise<void> }).flock();
    })();
    try {
      await Promise.race([acquire, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    return await fn();
  } finally {
    // Closing the fd releases the BSD flock automatically; the lock
    // survives even if acquisition raced with timeout because flock is
    // held on the kernel fd object, not the JS Promise.
    await fd.close().catch(() => undefined);
  }
}

/** Files in the data dir that look like leftover temp files from a crashed
 * save() or interrupted restore. Matched by the `*.tmp` suffix; we keep the
 * pattern conservative so a future legitimate file is not deleted. */
const STRAY_TEMP_PATTERN = /\.tmp$/;

const allowedPeerCreateFields = new Set([
  "name",
  "public_key",
  "publicKey",
  "generate_keys",
  "generateKeys",
  "allowed_ips",
  "allowedIps",
  "dns_servers",
  "dnsServers",
  "persistent_keepalive",
  "persistentKeepalive",
  "expires_at",
  "expiresAt",
  // NEW (P3.1) — link a peer to a Person and tag it with a device label.
  "person_id",
  "personId",
  "device_label",
  "deviceLabel"
]);

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields: Record<string, string[]> = {}
  ) {
    super(message);
  }
}

export class StateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: EngineConfig,
    private readonly sink?: AuditSink
  ) {}

  async load(): Promise<EngineState> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    // Stray temp files from an interrupted save() or restore() are removed
    // silently so the next load() never reads a half-written state.
    await this.cleanupStrayTempFiles();
    try {
      const raw = await fs.readFile(this.config.statePath, "utf8");
      const parsed = JSON.parse(raw) as EngineState;
      // Forward-migration: engines older than P3.1 wrote state.json without
      // `persons`. Adding an empty array keeps reads + writes well-typed.
      // We do NOT persist here — the array will land in state.json on the
      // next `save()`, which keeps this idempotent across reboots.
      if (!Array.isArray(parsed.persons)) {
        parsed.persons = [];
      }
      // NEW (P3.4) — engines older than P3.4 wrote state.json without an
      // `expiryWarned` dedupe map. Initialize via `as any` shim since
      // EngineState (types.ts) is read-only for this wave. Same on-disk
      // migration pattern as `persons` above: we set in memory, save()
      // persists it on the next mutation.
      if (!parsed || typeof parsed !== "object") {
        return this.createInitialStateIfMissing();
      }
      const expiryWarned = (parsed as unknown as { expiryWarned?: unknown }).expiryWarned;
      if (!expiryWarned || typeof expiryWarned !== "object" || Array.isArray(expiryWarned)) {
        (parsed as unknown as { expiryWarned: Record<string, string> }).expiryWarned = {};
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.createInitialStateIfMissing();
    }
  }

  async save(state: EngineState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await atomicWriteFile(this.config.statePath, payload);
  }

  private async cleanupStrayTempFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.config.dataDir);
      const stray = entries.filter((name) => STRAY_TEMP_PATTERN.test(name));
      await Promise.all(
        stray.map((name) =>
          fs.unlink(path.join(this.config.dataDir, name)).catch(() => undefined)
        )
      );
    } catch {
      // best-effort: don't fail boot if cleanup can't run (e.g. dataDir
      // just-created and we raced another writer, or permission denied).
    }
  }

  async createPeer(input: unknown): Promise<PeerRecord> {
    const body = this.parsePeerCreate(input);

    return this.update((state) => {
      const name = body.name.trim();
      const now = new Date().toISOString();

      if (state.peers.some((peer) => peer.status !== "deleted" && peer.name === name)) {
        throw new ValidationError("Request validation failed.", { name: ["must be unique"] });
      }

      return this.createPeerInState(state, body, name, now);
    });
  }

  async deletePeer(id: string): Promise<PeerRecord> {
    return this.update((state) => {
      const peer = state.peers.find((candidate) => candidate.id === id);
      if (!peer || peer.status === "deleted") {
        throw new ValidationError("Peer not found.", { id: ["not found"] });
      }

      const now = new Date().toISOString();
      peer.status = "deleted";
      peer.revokedAt ??= now;
      peer.deletedAt = now;
      peer.updatedAt = now;
      state.revision += 1;
      this.appendEvent(state, {
        action: "peer.deleted",
        targetId: peer.id,
        targetName: peer.name,
        createdAt: now
      });

      return peer;
    });
  }

  async revokePeer(id: string): Promise<PeerRecord> {
    return this.update((state) => {
      const peer = state.peers.find((candidate) => candidate.id === id);
      if (!peer || peer.status === "deleted") {
        throw new ValidationError("Peer not found.", { id: ["not found"] });
      }

      const now = new Date().toISOString();
      peer.status = "revoked";
      peer.revokedAt = now;
      peer.updatedAt = now;
      state.revision += 1;
      this.appendEvent(state, {
        action: "peer.revoked",
        targetId: peer.id,
        targetName: peer.name,
        createdAt: now
      });

      return peer;
    });
  }

  // ── Expiry automation (P3.4) ────────────────────────────────────────────
  /**
   * Scan active peers for expiry transitions:
   *   1. Peer already past `expiresAt` and `autoRevoke=true` → revoke it
   *      (status="revoked", revokedAt=now) and emit `peer.expired.auto_revoked`.
   *   2. Peer past expiry but `autoRevoke=false` → leave status="active"
   *      (the API still reports it as "expired" via peerApiStatus), report
   *      in `expired[]`, emit `peer.expired.warned`.
   *   3. Peer within `warnWithinDays` of expiry (and not yet expired) →
   *      report in `expiring_soon[]`, emit `peer.expiring.warned` at most
   *      once every 24h per peer (dedupe via state.expiryWarned).
   *
   * Lazy sweep — invoked on `/v1/status` and `/v1/expiring`. No background
   * ticker is started by design (P3.4 spec rule).
   */
  async sweepExpired(opts: {
    autoRevoke: boolean;
    warnWithinDays: number;
    actor?: string;
    now?: Date;
  }): Promise<{
    expired: string[];
    auto_revoked: string[];
    expiring_soon: Array<{
      peer_id: string;
      name: string;
      expires_at: string;
      days_remaining: number;
    }>;
  }> {
    const actor = opts.actor ?? "engine.expiry.sweep";
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    return this.update(async (state) => {
      // EngineState is read-only for this wave (types.ts is off-limits), so
      // reach into the dedupe map via the `as any` shim. load() initializes
      // it as an empty object for older state files.
      const warned = ((state as unknown as { expiryWarned?: Record<string, string> }).expiryWarned ?? {}) as Record<
        string,
        string
      >;
      const warnedNext: Record<string, string> = { ...warned };

      const expired: string[] = [];
      const auto_revoked: string[] = [];
      const expiring_soon: Array<{
        peer_id: string;
        name: string;
        expires_at: string;
        days_remaining: number;
      }> = [];

      let mutated = false;

      for (const peer of state.peers) {
        if (peer.status !== "active") continue;
        if (!peer.expiresAt) continue;

        const expiresMs = Date.parse(peer.expiresAt);
        if (!Number.isFinite(expiresMs)) continue;

        const msRemaining = expiresMs - now.getTime();
        const daysRemaining = msRemaining / (24 * 60 * 60 * 1000);

        if (msRemaining <= 0) {
          // Expired. Either auto-revoke or just warn.
          if (opts.autoRevoke) {
            peer.status = "revoked";
            peer.revokedAt = nowIso;
            peer.updatedAt = nowIso;
            mutated = true;
            auto_revoked.push(peer.id);
            expired.push(peer.id);
            const daysOverdue = Math.abs(daysRemaining);
            this.appendEvent(state, {
              action: "peer.expired.auto_revoked" as unknown as AuditAction,
              actor,
              targetId: peer.id,
              targetName: peer.name,
              createdAt: nowIso,
              metadata: {
                previous_status: "active",
                expires_at: peer.expiresAt,
                days_overdue: Number(daysOverdue.toFixed(2))
              }
            });
            // Mirror the manual revoke event so existing consumers (admin UI
            // counters, audit log filters) keep working without joining two
            // event types.
            this.appendEvent(state, {
              action: "peer.revoked",
              actor,
              targetId: peer.id,
              targetName: peer.name,
              createdAt: nowIso,
              metadata: {
                trigger: "expiry.auto_revoke",
                expires_at: peer.expiresAt,
                days_overdue: Number(daysOverdue.toFixed(2))
              }
            });
            // Dedupe map is per-peer; clear on revoke so a future re-issuance
            // can warn again.
            delete warnedNext[peer.id];
          } else {
            expired.push(peer.id);
            const daysOverdue = Math.abs(daysRemaining);
            this.appendEvent(state, {
              action: "peer.expired.warned" as unknown as AuditAction,
              actor,
              targetId: peer.id,
              targetName: peer.name,
              createdAt: nowIso,
              metadata: {
                peer_id: peer.id,
                expires_at: peer.expiresAt,
                days_overdue: Number(daysOverdue.toFixed(2))
              }
            });
          }
          continue;
        }

        if (opts.warnWithinDays > 0 && daysRemaining <= opts.warnWithinDays) {
          expiring_soon.push({
            peer_id: peer.id,
            name: peer.name,
            expires_at: peer.expiresAt,
            days_remaining: Number(daysRemaining.toFixed(2))
          });

          // Dedupe: only emit `peer.expiring.warned` if we haven't warned in
          // the last 24h. Avoids audit-log spam when /status is polled.
          const lastWarned = warned[peer.id];
          const lastWarnedMs = lastWarned ? Date.parse(lastWarned) : Number.NaN;
          const shouldWarn = !Number.isFinite(lastWarnedMs) || now.getTime() - lastWarnedMs > twentyFourHoursMs;
          if (shouldWarn) {
            warnedNext[peer.id] = nowIso;
            this.appendEvent(state, {
              action: "peer.expiring.warned" as unknown as AuditAction,
              actor,
              targetId: peer.id,
              targetName: peer.name,
              createdAt: nowIso,
              metadata: {
                expires_at: peer.expiresAt,
                days_remaining: Number(daysRemaining.toFixed(2)),
                warn_within_days: opts.warnWithinDays
              }
            });
          }
        }
      }

      if (mutated || Object.keys(warnedNext).length !== Object.keys(warned).length ||
          Object.entries(warnedNext).some(([k, v]) => warned[k] !== v)) {
        (state as unknown as { expiryWarned: Record<string, string> }).expiryWarned = warnedNext;
      }

      return { expired, auto_revoked, expiring_soon };
    });
  }

  // ── Person CRUD (P3.1) ─────────────────────────────────────────────────────
  // Persons are a soft-deleted concept: `deletePerson` defaults to archive
  // (status="archived") so we never silently lose the family/group history.
  // Only `force: true` triggers a hard delete; even then peers owned by
  // the person are REVOKED, not deleted, so the audit trail stays intact.

  async createPerson(input: unknown): Promise<PersonRecord> {
    const body = this.parsePersonCreate(input);
    return this.update((state) => {
      const nameError = validatePersonName(body.displayName);
      if (nameError) {
        throw new ValidationError("Request validation failed.", { display_name: [nameError] });
      }
      const now = new Date().toISOString();
      const person: PersonRecord = {
        id: randomUUID(),
        displayName: body.displayName,
        notes: body.notes,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      state.persons.push(person);
      state.revision += 1;
      this.appendEvent(state, {
        action: "person.created",
        targetId: person.id,
        targetName: person.displayName,
        createdAt: now,
        metadata: { has_notes: body.notes !== undefined }
      });
      return person;
    });
  }

  async updatePerson(
    id: string,
    patch: { displayName?: string; notes?: string; status?: PersonStatus }
  ): Promise<PersonRecord> {
    return this.update((state) => {
      const person = state.persons.find((candidate) => candidate.id === id);
      if (!person) {
        throw new ValidationError("Person not found.", { id: ["not found"] });
      }

      // Reject empty patches so the API can distinguish no-op from missing
      // arguments. Real callers always pass at least one field.
      if (
        patch.displayName === undefined &&
        patch.notes === undefined &&
        patch.status === undefined
      ) {
        throw new ValidationError("Request validation failed.", {
          body: ["at least one of display_name, notes, status is required"]
        });
      }

      const previousStatus = person.status;
      if (patch.displayName !== undefined) {
        const trimmed = patch.displayName.trim();
        const nameError = validatePersonName(trimmed);
        if (nameError) {
          throw new ValidationError("Request validation failed.", { display_name: [nameError] });
        }
        person.displayName = trimmed;
      }
      if (patch.notes !== undefined) {
        if (patch.notes === null) {
          // `null` clears the notes field; treat as a present patch.
          person.notes = undefined;
        } else {
          const notesError = validatePersonNotes(patch.notes);
          if (notesError) {
            throw new ValidationError("Request validation failed.", { notes: [notesError] });
          }
          person.notes = patch.notes;
        }
      }
      if (patch.status !== undefined) {
        if (patch.status !== "active" && patch.status !== "archived") {
          throw new ValidationError("Request validation failed.", {
            status: ["must be 'active' or 'archived'"]
          });
        }
        person.status = patch.status;
      }

      const now = new Date().toISOString();
      person.updatedAt = now;
      state.revision += 1;
      const changedFields: Record<string, boolean> = {};
      if (patch.displayName !== undefined) changedFields.display_name = true;
      if (patch.notes !== undefined) changedFields.notes = true;
      if (patch.status !== undefined) changedFields.status = true;
      this.appendEvent(state, {
        action: "person.updated",
        targetId: person.id,
        targetName: person.displayName,
        createdAt: now,
        metadata: { changed_fields: JSON.stringify(changedFields) }
      });
      // Surface explicit archive transitions on their own audit action so
      // operators can alert on family/group archival events without
      // matching by metadata.
      if (patch.status !== undefined && patch.status !== previousStatus) {
        if (patch.status === "archived") {
          this.appendEvent(state, {
            action: "person.archived",
            targetId: person.id,
            targetName: person.displayName,
            createdAt: now
          });
        } else if (previousStatus === "archived") {
          // Re-activation can be inferred from the `status` change but we
          // also write a dedicated `person.updated` above. No separate
          // "person.reactivated" action in the P3.1 spec — keep it tight.
        }
      }
      return person;
    });
  }

  async listPersons(filter?: { status?: PersonStatus }): Promise<PersonRecord[]> {
    return this.update(async (state) => {
      const status = filter?.status;
      const persons = status ? state.persons.filter((person) => person.status === status) : state.persons;
      // Return a shallow clone so callers cannot mutate engine state.
      return persons.map((person) => ({ ...person }));
    });
  }

  async deletePerson(
    id: string,
    options?: { force?: boolean }
  ): Promise<PersonRecord> {
    return this.update(async (state) => {
      const person = state.persons.find((candidate) => candidate.id === id);
      if (!person) {
        throw new ValidationError("Person not found.", { id: ["not found"] });
      }

      const now = new Date().toISOString();
      const force = options?.force === true;

      if (!force) {
        // Default path: soft-delete by archiving. New device creation
        // for this person is rejected by createPeerInState; existing
        // peers stay attached but can be revoked separately.
        const previousStatus = person.status;
        person.status = "archived";
        person.updatedAt = now;
        state.revision += 1;
        if (previousStatus !== "archived") {
          this.appendEvent(state, {
            action: "person.archived",
            targetId: person.id,
            targetName: person.displayName,
            createdAt: now
          });
        }
        return person;
      }

      // Force path: hard-delete the person, but revoke (not delete)
      // their peers so the audit history survives. Cascade-order matters:
      // revoke peers first so the emitted `person.device.removed` events
      // can still reference the (about-to-be-gone) person record.
      const peersBelonging = state.peers.filter((peer) => peer.personId === person.id);
      const revokedPeerIds: string[] = [];
      for (const peer of peersBelonging) {
        if (peer.status === "revoked" || peer.status === "deleted") continue;
        peer.status = "revoked";
        peer.revokedAt ??= now;
        peer.updatedAt = now;
        revokedPeerIds.push(peer.id);
        this.appendEvent(state, {
          action: "person.device.removed",
          targetId: person.id,
          targetName: person.displayName,
          createdAt: now,
          metadata: {
            peer_id: peer.id,
            peer_name: peer.name,
            device_label: peer.deviceLabel ?? null
          }
        });
      }

      state.persons = state.persons.filter((candidate) => candidate.id !== person.id);
      state.revision += 1;
      this.appendEvent(state, {
        action: "person.deleted",
        targetId: person.id,
        targetName: person.displayName,
        createdAt: now,
        metadata: {
          force: true,
          revoked_peer_count: revokedPeerIds.length
        }
      });
      return person;
    });
  }

  /**
   * Revoke every peer attached to a person. Idempotent: peers already in
   * `revoked` or `deleted` status are skipped and reported in
   * `alreadyRevoked`. Emits a single `person.devices.revoked` summary
   * event so audit consumers don't need to join one event per peer.
   */
  async revokePersonDevices(
    personId: string,
    actor?: string
  ): Promise<{ personId: string; revokedPeerIds: string[]; alreadyRevoked: number }> {
    return this.update(async (state) => {
      const person = state.persons.find((candidate) => candidate.id === personId);
      if (!person) {
        throw new ValidationError("Person not found.", { id: ["not found"] });
      }
      const now = new Date().toISOString();
      const revokedPeerIds: string[] = [];
      let alreadyRevoked = 0;
      for (const peer of state.peers) {
        if (peer.personId !== personId) continue;
        if (peer.status === "revoked" || peer.status === "deleted") {
          alreadyRevoked += 1;
          continue;
        }
        peer.status = "revoked";
        peer.revokedAt = now;
        peer.updatedAt = now;
        revokedPeerIds.push(peer.id);
      }
      state.revision += 1;
      this.appendEvent(state, {
        action: "person.devices.revoked",
        actor: actor ?? "engine",
        targetId: person.id,
        targetName: person.displayName,
        createdAt: now,
        metadata: {
          revoked_count: revokedPeerIds.length,
          already_revoked: alreadyRevoked,
          device_labels: JSON.stringify(
            state.peers
              .filter((peer) => revokedPeerIds.includes(peer.id))
              .map((peer) => peer.deviceLabel ?? null)
          )
        }
      });
      return { personId: person.id, revokedPeerIds, alreadyRevoked };
    });
  }

  private parsePersonCreate(input: unknown): { displayName: string; notes?: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ValidationError("Request validation failed.", { body: ["must be a JSON object"] });
    }
    const body = input as Record<string, unknown>;
    const allowedFields = new Set(["display_name", "displayName", "notes"]);
    const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unknown.length > 0) {
      throw new ValidationError("Request validation failed.", {
        unknown_fields: unknown.map((key) => `${key} is not allowed`)
      });
    }
    const rawName = body.display_name ?? body.displayName;
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      throw new ValidationError("Request validation failed.", { display_name: ["is required"] });
    }
    const notesRaw = body.notes;
    let notes: string | undefined;
    if (notesRaw !== undefined && notesRaw !== null) {
      if (typeof notesRaw !== "string") {
        throw new ValidationError("Request validation failed.", { notes: ["must be a string"] });
      }
      const notesError = validatePersonNotes(notesRaw);
      if (notesError) {
        throw new ValidationError("Request validation failed.", { notes: [notesError] });
      }
      notes = notesRaw;
    }
    return { displayName: rawName.trim(), notes };
  }

  appendEvent(
    state: EngineState,
    event: {
      action: AuditAction;
      createdAt?: string;
      actor?: string;
      targetId?: string;
      targetName?: string;
      metadata?: AuditEvent["metadata"];
    }
  ): AuditEvent {
    const record: AuditEvent = {
      id: randomUUID(),
      action: event.action,
      actor: event.actor ?? "engine",
      targetId: event.targetId,
      targetName: event.targetName,
      revision: state.revision,
      createdAt: event.createdAt ?? new Date().toISOString(),
      metadata: event.metadata
    };

    state.events = [...(state.events ?? []), record].slice(-MAX_AUDIT_EVENTS);

    // Fire-and-forget persist to the persistent NDJSON sink. Sinks MUST NOT
    // throw — wrap defensively so a faulty sink never crashes the engine.
    if (this.sink) {
      try {
        this.sink.write(record);
      } catch {
        // audit must not crash engine; swallowed by spec
      }
    }

    return record;
  }

  async update<T>(mutate: (state: EngineState) => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeQueue;
    this.writeQueue = previous.then(() => next, () => next);

    await previous;
    try {
      const state = await this.load();
      const result = await mutate(state);
      await this.save(state);
      return result;
    } finally {
      release();
    }
  }

  private async createPeerInState(
    state: EngineState,
    body: {
      publicKey?: string;
      generateKeys: boolean;
      allowedIps?: string[];
      dnsServers?: string[];
      persistentKeepalive?: number;
      expiresAt?: string;
      personId?: string;
      deviceLabel?: string;
    },
    name: string,
    now: string
  ): Promise<PeerRecord> {
    const id = randomUUID();
    const generated = body.generateKeys || !body.publicKey;
    const keyPair = generated ? await generateKeyPair(this.config.dryRun, `peer:${id}:${name}`) : undefined;
    const publicKey = body.publicKey ?? keyPair?.publicKey;
    if (!publicKey) {
      throw new ValidationError("Request validation failed.", { public_key: ["is required when generate_keys is false"] });
    }

    if (state.peers.some((peer) => peer.status !== "deleted" && peer.publicKey === publicKey)) {
      throw new ValidationError("Request validation failed.", { public_key: ["must be unique"] });
    }

    // NEW (P3.1) — if the caller linked this peer to a Person, that Person
    // must already exist AND must be in `active` status. Archived persons
    // cannot host new devices; admin must re-activate or create a new
    // person for onboarding.
    let personId: string | undefined;
    let deviceLabel: string | undefined;
    if (body.personId !== undefined) {
      const person = state.persons.find((candidate) => candidate.id === body.personId);
      if (!person) {
        throw new ValidationError("Request validation failed.", { person_id: ["person not found"] });
      }
      if (person.status !== "active") {
        throw new ValidationError("Request validation failed.", { person_id: ["person is archived"] });
      }
      personId = person.id;
      deviceLabel = body.deviceLabel;
    } else if (body.deviceLabel !== undefined) {
      // deviceLabel without personId is allowed (e.g. legacy onboarding),
      // but we still validate the label shape so the UI can rely on it.
      deviceLabel = body.deviceLabel;
    }

    const addressV4 = allocatePeerAddress(
      state.server.tunnelCidrV4,
      state.peers.filter((peer) => peer.status !== "deleted").map((peer) => peer.addressV4)
    );

    const peer: PeerRecord = {
      id,
      name,
      publicKey,
      privateKey: keyPair?.privateKey,
      addressV4,
      allowedIps: body.allowedIps ?? state.server.defaultAllowedIps,
      dnsServers: body.dnsServers ?? state.server.defaultDnsServers,
      persistentKeepalive: body.persistentKeepalive ?? state.server.persistentKeepalive,
      status: "active",
      expiresAt: body.expiresAt,
      createdAt: now,
      updatedAt: now,
      personId,
      deviceLabel
    };

    state.peers.push(peer);
    state.revision += 1;
    this.appendEvent(state, {
      action: "peer.created",
      targetId: peer.id,
      targetName: peer.name,
      createdAt: now,
      metadata: {
        address_v4: peer.addressV4,
        generated_keys: generated,
        person_id: personId ?? null,
        device_label: deviceLabel ?? null
      }
    });
    // NEW (P3.1) — when a peer is born under a Person we additionally
    // surface a `person.device.added` event so audit consumers can
    // reconstruct family/group lifecycle without joining two streams.
    if (personId) {
      const person = state.persons.find((candidate) => candidate.id === personId);
      this.appendEvent(state, {
        action: "person.device.added",
        targetId: person?.id,
        targetName: person?.displayName,
        createdAt: now,
        metadata: {
          peer_id: peer.id,
          peer_name: peer.name,
          device_label: deviceLabel ?? null
        }
      });
    }
    return peer;
  }

  private async initialState(): Promise<EngineState> {
    const now = new Date().toISOString();
    const keyPair = await generateKeyPair(this.config.dryRun, "server:default");
    const parsed = parseIpv4Cidr(this.config.tunnelCidrV4);

    return {
      version: 1,
      revision: 1,
      server: {
        interfaceName: this.config.interfaceName,
        listenPort: this.config.listenPort,
        endpointHost: this.config.endpointHost,
        endpointPort: this.config.endpointPort,
        tunnelCidrV4: this.config.tunnelCidrV4,
        serverAddressV4: `${numberToIpv4(parsed.firstHost)}/32`,
        serverPublicKey: keyPair.publicKey,
        serverPrivateKey: keyPair.privateKey,
        defaultAllowedIps: this.config.defaultAllowedIps,
        defaultDnsServers: this.config.defaultDnsServers,
        persistentKeepalive: this.config.persistentKeepalive,
        natEnabled: this.config.natEnabled,
        forwardingRequired: this.config.forwardingRequired,
        updatedAt: now
      },
      peers: [],
      persons: [],
      events: [
        {
          id: randomUUID(),
          action: "state.initialized",
          actor: "engine",
          revision: 1,
          createdAt: now,
          metadata: {
            interface: this.config.interfaceName,
            tunnel_cidr_v4: this.config.tunnelCidrV4,
            dry_run: this.config.dryRun
          }
        }
      ]
    };
  }

  private async createInitialStateIfMissing(): Promise<EngineState> {
    const state = await this.initialState();
    const payload = `${JSON.stringify(state, null, 2)}\n`;

    try {
      await fs.writeFile(this.config.statePath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await fs.readFile(this.config.statePath, "utf8");
      return JSON.parse(raw) as EngineState;
    }
  }

  private parsePeerCreate(input: unknown): {
    name: string;
    publicKey?: string;
    generateKeys: boolean;
    allowedIps?: string[];
    dnsServers?: string[];
    persistentKeepalive?: number;
    expiresAt?: string;
    personId?: string;
    deviceLabel?: string;
  } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ValidationError("Request validation failed.", { body: ["must be a JSON object"] });
    }

    const body = input as Record<string, unknown>;
    const unknown = Object.keys(body).filter((key) => !allowedPeerCreateFields.has(key));
    if (unknown.length > 0) {
      throw new ValidationError("Request validation failed.", {
        unknown_fields: unknown.map((key) => `${key} is not allowed`)
      });
    }

    const name = body.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ValidationError("Request validation failed.", { name: ["is required"] });
    }
    const nameError = validatePeerName(name.trim());
    if (nameError) {
      throw new ValidationError("Request validation failed.", { name: [nameError] });
    }

    const rawPublicKey = body.public_key ?? body.publicKey;
    const publicKey = optionalString(rawPublicKey, "public_key");
    if (publicKey) {
      const keyError = validateWireGuardKey(publicKey);
      if (keyError) throw new ValidationError("Request validation failed.", { public_key: [keyError] });
    }

    const allowedIps = optionalStringList(body.allowed_ips ?? body.allowedIps, "allowed_ips");
    const invalidAllowedIp = allowedIps?.find((item) => validateAllowedIp(item));
    if (invalidAllowedIp) {
      throw new ValidationError("Request validation failed.", { allowed_ips: [`${invalidAllowedIp}: ${validateAllowedIp(invalidAllowedIp)}`] });
    }

    const dnsServers = optionalStringList(body.dns_servers ?? body.dnsServers, "dns_servers");
    const invalidDns = dnsServers?.find((item) => validateDnsServer(item));
    if (invalidDns) {
      throw new ValidationError("Request validation failed.", { dns_servers: [`${invalidDns}: ${validateDnsServer(invalidDns)}`] });
    }

    const expiresAt = optionalString(body.expires_at ?? body.expiresAt, "expires_at");
    if (expiresAt) {
      const expiryError = validateExpiresAt(expiresAt);
      if (expiryError) throw new ValidationError("Request validation failed.", { expires_at: [expiryError] });
    }

    // NEW (P3.1) — person linkage + device label. Shape-only validation
    // here; existence/active checks happen in `createPeerInState` against
    // the loaded state.
    const personId = optionalString(body.person_id ?? body.personId, "person_id");
    if (personId) {
      const personIdError = validatePersonId(personId);
      if (personIdError) {
        throw new ValidationError("Request validation failed.", { person_id: [personIdError] });
      }
      if (personId === UNASSIGNED_PERSON_ID) {
        // Reserved sentinel — assigning it explicitly is meaningless; ask
        // the caller to omit the field if they meant "no person".
        throw new ValidationError("Request validation failed.", {
          person_id: ["is a reserved identifier; omit the field to leave a peer unassigned"]
        });
      }
    }
    const deviceLabel = optionalString(body.device_label ?? body.deviceLabel, "device_label");
    if (deviceLabel) {
      const labelError = validateDeviceLabel(deviceLabel);
      if (labelError) throw new ValidationError("Request validation failed.", { device_label: [labelError] });
    }

    return {
      name,
      publicKey,
      generateKeys: optionalBool(body.generate_keys ?? body.generateKeys, "generate_keys") ?? !publicKey,
      allowedIps,
      dnsServers,
      persistentKeepalive: optionalNumber(body.persistent_keepalive ?? body.persistentKeepalive, "persistent_keepalive"),
      expiresAt,
      personId,
      deviceLabel
    };
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("Request validation failed.", { [field]: ["must be a non-empty string"] });
  }
  return value.trim();
}

function optionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ValidationError("Request validation failed.", { [field]: ["must be a boolean"] });
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ValidationError("Request validation failed.", { [field]: ["must be an integer from 0 to 65535"] });
  }
  return value;
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new ValidationError("Request validation failed.", { [field]: ["must be a list of non-empty strings"] });
  }
  return value.map((item) => item.trim());
}

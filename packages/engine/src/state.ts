import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { allocatePeerAddress, parseIpv4Cidr, numberToIpv4 } from "./ip.js";
import { generateKeyPair } from "./keys.js";
import { validateAllowedIp, validateDnsServer, validateExpiresAt, validatePeerName, validateWireGuardKey } from "./peers.js";
import type { AuditAction, AuditEvent, EngineConfig, EngineState, PeerRecord } from "./types.js";

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
  "expiresAt"
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

  constructor(private readonly config: EngineConfig) {}

  async load(): Promise<EngineState> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    // Stray temp files from an interrupted save() or restore() are removed
    // silently so the next load() never reads a half-written state.
    await this.cleanupStrayTempFiles();
    try {
      const raw = await fs.readFile(this.config.statePath, "utf8");
      return JSON.parse(raw) as EngineState;
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
      updatedAt: now
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
        generated_keys: generated
      }
    });
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

    return {
      name,
      publicKey,
      generateKeys: optionalBool(body.generate_keys ?? body.generateKeys, "generate_keys") ?? !publicKey,
      allowedIps,
      dnsServers,
      persistentKeepalive: optionalNumber(body.persistent_keepalive ?? body.persistentKeepalive, "persistent_keepalive"),
      expiresAt
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

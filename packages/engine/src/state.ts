import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { allocatePeerAddress, parseIpv4Cidr, numberToIpv4 } from "./ip.js";
import { generateKeyPair } from "./keys.js";
import type { EngineConfig, EngineState, PeerRecord } from "./types.js";

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
    try {
      const raw = await fs.readFile(this.config.statePath, "utf8");
      return JSON.parse(raw) as EngineState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.createInitialStateIfMissing();
    }
  }

  async save(state: EngineState): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    const tempPath = path.join(
      this.config.dataDir,
      `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, this.config.statePath);
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

      return peer;
    });
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
      peers: []
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

    const rawPublicKey = body.public_key ?? body.publicKey;
    const publicKey = optionalString(rawPublicKey, "public_key");

    return {
      name,
      publicKey,
      generateKeys: optionalBool(body.generate_keys ?? body.generateKeys, "generate_keys") ?? !publicKey,
      allowedIps: optionalStringList(body.allowed_ips ?? body.allowedIps, "allowed_ips"),
      dnsServers: optionalStringList(body.dns_servers ?? body.dnsServers, "dns_servers"),
      persistentKeepalive: optionalNumber(body.persistent_keepalive ?? body.persistentKeepalive, "persistent_keepalive"),
      expiresAt: optionalString(body.expires_at ?? body.expiresAt, "expires_at")
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
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError("Request validation failed.", { [field]: ["must be a non-negative integer"] });
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

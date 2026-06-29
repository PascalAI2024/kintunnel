import crypto from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { BackupError, createBackupStorage } from "./backup.js";
import { renderClientConfig } from "./config-render.js";
import { assertStrongEngineApiToken } from "./env.js";
import { runHealthChecks } from "./health.js";
import { isPeerActive, peerApiStatus } from "./peers.js";
import { getCapabilities, getRuntimeState, reconcile } from "./runtime.js";
import { StateStore, ValidationError } from "./state.js";
import type { AuditEvent, BackupManifest, EngineConfig, PeerRecord, ServerSettings } from "./types.js";

export function createApp(config: EngineConfig) {
  assertStrongEngineApiToken(config.apiToken, config.env);

  const app = express();
  const api = express.Router();
  const store = new StateStore(config);
  const backups = createBackupStorage(config, store);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res, next) => {
    try {
      const capabilities = await getCapabilities(config);
      const state = await store.load();
      const report = await runHealthChecks(config, state);
      const ok = report.ok && (config.dryRun || capabilities.hasWg);
      res.status(ok ? 200 : 503).json({
        ok,
        service: "kintunnel-engine",
        dry_run: config.dryRun,
        messages: capabilities.messages,
        checks: report.checks,
        required_failing: report.required_failing,
        warnings: report.warnings
      });
    } catch (error) {
      next(error);
    }
  });

  api.use(requireApiToken(config.apiToken));

  api.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "kintunnel-engine",
      dry_run: config.dryRun
    });
  });

  api.get("/capabilities", async (_req, res, next) => {
    try {
      const capabilities = await getCapabilities(config);
      res.json({ capabilities });
    } catch (error) {
      next(error);
    }
  });

  api.get("/status", async (_req, res, next) => {
    try {
      const state = await store.load();
      const runtime = await getRuntimeState(config, state);
      res.json({
        ok: true,
        ready: runtime.exists,
        revision: state.revision,
        dry_run: config.dryRun,
        interface: {
          name: state.server.interfaceName,
          listen_port: state.server.listenPort,
          public_key: state.server.serverPublicKey,
          up: runtime.exists
        },
        server: sanitizeServer(state.server),
        peers: {
          total: state.peers.length,
          active: state.peers.filter((peer) => isPeerActive(peer)).length,
          expired: state.peers.filter((peer) => peerApiStatus(peer) === "expired").length,
          revoked: state.peers.filter((peer) => peer.status === "revoked").length,
          deleted: state.peers.filter((peer) => peer.status === "deleted").length
        },
        runtime,
        last_reconcile: state.lastReconcile,
        checked_at: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });

  api.get("/peers", async (req, res, next) => {
    try {
      const state = await store.load();
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const peers = status ? state.peers.filter((peer) => peer.status === status) : state.peers;
      res.json({ peers: peers.map(sanitizePeer) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/events", async (req, res, next) => {
    try {
      const state = await store.load();
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 50;
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
      const events = [...(state.events ?? [])].reverse().slice(0, limit).map(sanitizeEvent);
      res.json({ events });
    } catch (error) {
      next(error);
    }
  });

  api.post("/peers", async (req, res, next) => {
    try {
      const peer = await store.createPeer(req.body);
      res.status(201).json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/peers/:id", async (req, res, next) => {
    try {
      const state = await store.load();
      const peer = state.peers.find((candidate) => candidate.id === req.params.id);
      if (!peer || peer.status === "deleted") {
        throw new ValidationError("Peer not found.", { id: ["not found"] });
      }

      res.json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/peers/:id/config", async (req, res, next) => {
    try {
      const clientConfig = await store.update((state) => {
        const peer = state.peers.find((candidate) => candidate.id === req.params.id);
        if (!peer || !isPeerActive(peer)) {
          throw new ValidationError("Peer not found.", { id: ["not found or not active"] });
        }

        store.appendEvent(state, {
          action: "peer.config.exported",
          targetId: peer.id,
          targetName: peer.name,
          metadata: {
            format: "wireguard",
            status: peerApiStatus(peer)
          }
        });

        return renderClientConfig(peer, state.server);
      });

      setSensitiveHeaders(res);
      res.type("text/plain").send(clientConfig);
    } catch (error) {
      next(error);
    }
  });

  api.post("/peers/:id/revoke", async (req, res, next) => {
    try {
      const peer = await store.revokePeer(req.params.id);
      res.json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/peers/:id", async (req, res, next) => {
    try {
      const peer = await store.deletePeer(req.params.id);
      res.json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/reconcile", async (_req, res, next) => {
    try {
      const result = await store.update(async (state) => {
        const reconcileResult = await reconcile(config, state);
        state.lastReconcile = reconcileResult;
        state.revision += 1;
        store.appendEvent(state, {
          action: "reconcile.completed",
          metadata: {
            ok: reconcileResult.ok,
            dry_run: reconcileResult.dryRun,
            applied: reconcileResult.applied,
            active_peer_count: reconcileResult.activePeerCount
          }
        });
        return reconcileResult;
      });
      res.status(result.ok ? 200 : 409).json({ reconcile: result });
    } catch (error) {
      next(error);
    }
  });

  api.post("/backups", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { trigger?: string; actor?: string };
      const allowedTriggers = ["manual", "post-restore", "scheduled", "pre-rotate"] as const;
      type AllowedTrigger = (typeof allowedTriggers)[number];
      const trigger: AllowedTrigger = allowedTriggers.includes(body.trigger as AllowedTrigger)
        ? (body.trigger as AllowedTrigger)
        : "manual";
      const actor = typeof body.actor === "string" && body.actor.trim().length > 0 ? body.actor.trim() : "engine";
      const summary = await backups.backupCreate({ trigger, actor });
      res.status(201).json({ snapshot: summary });
    } catch (error) {
      next(error);
    }
  });

  api.get("/backups", async (_req, res, next) => {
    try {
      const snapshots = await backups.backupList();
      res.json({ snapshots });
    } catch (error) {
      next(error);
    }
  });

  api.get("/backups/:id", async (req, res, next) => {
    try {
      const manifestPath = path.join(config.backupDir, `snap-${req.params.id}`, "manifest.json");
      let raw: string;
      try {
        raw = await fs.readFile(manifestPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new BackupError("snapshot_not_found", `Snapshot not found: ${req.params.id}`);
        }
        throw new BackupError("io_error", (error as Error).message);
      }
      const manifest = JSON.parse(raw) as BackupManifest;
      res.json({ snapshot: manifest });
    } catch (error) {
      next(error);
    }
  });

  api.post("/backups/restore-plan", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { snapshot_id?: string };
      if (typeof body.snapshot_id !== "string" || body.snapshot_id.length === 0) {
        throw new ValidationError("Request validation failed.", { snapshot_id: ["is required"] });
      }
      const plan = await backups.backupRestorePlan(body.snapshot_id);
      res.json({ plan });
    } catch (error) {
      next(error);
    }
  });

  api.post("/backups/:id/restore", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { apply?: boolean; force?: boolean };
      if (typeof body.apply !== "boolean") {
        throw new ValidationError("Request validation failed.", { apply: ["is required (boolean)"] });
      }
      const actor = typeof (req.body as { actor?: string })?.actor === "string"
        ? (req.body as { actor: string }).actor
        : "engine";
      const result = await backups.backupRestore(
        {
          snapshot_id: req.params.id,
          apply: body.apply,
          force: body.force
        },
        actor
      );
      res.json({
        restored: true,
        safety_snapshot_id: result.safetySnapshotId,
        from_revision: result.fromRevision,
        applied: result.applied
      });
    } catch (error) {
      next(error);
    }
  });

  api.get("/backups/:id/export", async (req, res, next) => {
    try {
      const exportResult = await backups.backupExport(req.params.id);
      res.setHeader("Content-Type", exportResult.contentType);
      res.setHeader("Content-Length", String(exportResult.sizeBytes));
      res.setHeader("Content-Disposition", `attachment; filename="kintunnel-snapshot-${req.params.id}.json"`);
      res.setHeader("X-Backup-Size", String(exportResult.sizeBytes));
      exportResult.stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  api.delete("/backups/:id", async (req, res, next) => {
    try {
      const result = await backups.backupDelete(req.params.id);
      res.json({ deleted: { snapshot_id: result.snapshotId, size_bytes: result.sizeBytes } });
    } catch (error) {
      next(error);
    }
  });

  app.use("/v1", api);
  app.use("/api/v1", api);

  app.use(((error: unknown, _req: Request, res: Response, _next) => {
    if (error instanceof ValidationError) {
      res.status(error.message.includes("not found") ? 404 : 400).json({
        error: {
          code: error.message.includes("not found") ? "not_found" : "validation_failed",
          message: error.message,
          fields: error.fields
        }
      });
      return;
    }

    if (error instanceof BackupError) {
      const status = backupErrorStatus(error);
      res.status(status).json({
        error: {
          code: error.code,
          message: error.message
        }
      });
      return;
    }

    res.status(500).json({
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected engine error."
      }
    });
  }) satisfies ErrorRequestHandler);

  return app;
}

function sanitizePeer(peer: PeerRecord) {
  return {
    id: peer.id,
    name: peer.name,
    public_key: peer.publicKey,
    address_v4: peer.addressV4,
    allowed_ips: peer.allowedIps,
    dns_servers: peer.dnsServers,
    persistent_keepalive: peer.persistentKeepalive,
    status: peerApiStatus(peer),
    expires_at: peer.expiresAt,
    created_at: peer.createdAt,
    updated_at: peer.updatedAt,
    revoked_at: peer.revokedAt,
    deleted_at: peer.deletedAt
  };
}

function sanitizeEvent(event: AuditEvent) {
  return {
    id: event.id,
    action: event.action,
    actor: event.actor,
    target_id: event.targetId,
    target_name: event.targetName,
    revision: event.revision,
    created_at: event.createdAt,
    metadata: event.metadata
  };
}

function requireApiToken(apiToken: string) {
  return (req: Request, res: Response, next: () => void) => {
    const header = req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (safeEqual(bearer, apiToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Engine API token is required."
      }
    });
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function setSensitiveHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex");
}

function sanitizeServer(server: ServerSettings) {
  const { serverPrivateKey: _serverPrivateKey, ...safeServer } = server;
  return safeServer;
}

function backupErrorStatus(error: BackupError): number {
  switch (error.code) {
    case "snapshot_not_found":
      return 404;
    case "checksum_mismatch":
    case "import_invalid":
      return 422;
    case "refused_recent":
      return 409;
    case "lock_timeout":
      return 503;
    case "io_error":
    default:
      return 500;
  }
}

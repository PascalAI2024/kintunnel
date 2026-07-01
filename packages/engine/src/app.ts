import crypto from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { type AuditStore, createAuditStore } from "./audit-store.js";
import { BackupError, createBackupStorage } from "./backup.js";
import { renderClientConfig } from "./config-render.js";
import { assertStrongEngineApiToken, type ResolvedEngineConfig } from "./env.js";
import { runHealthChecks } from "./health.js";
import { createLogger } from "./logger.js";
import { type Counter, type Histogram, createMetricsRegistry } from "./metrics.js";
import { isPeerActive, peerApiStatus } from "./peers.js";
import { ApplyError, setApplyAuditSink } from "./apply.js";
import { setNetworkingAuditSink } from "./networking.js";
import { getCapabilities, getRuntimeState, reconcile } from "./runtime.js";
import { StateStore, ValidationError } from "./state.js";
import type {
  AuditEvent,
  BackupManifest,
  EngineConfig,
  PeerRecord,
  PersonRecord,
  ServerSettings
} from "./types.js";

export function createApp(config: EngineConfig): express.Express {
  assertStrongEngineApiToken(config.apiToken, config.env);

  const app = express();
  const api = express.Router();

  // The /v1/audit endpoint and durable audit persistence need fields that
  // live on ResolvedEngineConfig (set by loadConfig). We cast at the boundary
  // because createApp's public signature remains EngineConfig-compatible.
  const resolved = config as ResolvedEngineConfig;
  const auditLogger = createLogger({ service: "kintunnel-engine-audit" });
  // Synchronously construct the audit store so the sink is available at
  // StateStore construction time. Sinks fan out to the same internal write
  // queue that `audit.append(...)` uses; the only difference is sync
  // fire-and-forget vs. awaited append. The log directory is materialized
  // lazily on the first append (see AuditStoreImpl.doAppend).
  const audit: AuditStore = createAuditStore({
    logDir: resolved.auditLogDir,
    maxBytes: resolved.auditLogMaxBytes,
    retentionCount: resolved.auditLogRetentionCount,
    logger: auditLogger
  });
  const store = new StateStore(config, audit.sink);
  const backups = createBackupStorage(config, store);

  // Wire apply.ts and networking.ts's module-level sinks so their private
  // emitAudit helpers persist to the same NDJSON log as StateStore events.
  setApplyAuditSink(audit.sink);
  setNetworkingAuditSink(audit.sink);

  const metrics = createMetricsRegistry();
  // Default counters / gauges / histograms registered eagerly so /metrics
  // returns a stable surface even on a cold engine. `peers_*` are reset at
  // scrape time and re-derived from state.
  const peersTotal: Counter = metrics.counter("peers_total", "Total number of peers in any state");
  const peersActive: Counter = metrics.counter("peers_active", "Number of active peers");
  const peersRevoked: Counter = metrics.counter("peers_revoked", "Number of revoked peers");
  const reconcileRunsTotal: Counter = metrics.counter(
    "reconcile_runs_total",
    "Total reconcile runs",
    ["result"]
  );
  const applyFailuresTotal: Counter = metrics.counter(
    "apply_failures_total",
    "Total apply path failures",
    ["code"]
  );
  const backupCreatesTotal: Counter = metrics.counter(
    "backup_creates_total",
    "Total backup creates",
    ["result"]
  );
  const backupRestoresTotal: Counter = metrics.counter(
    "backup_restores_total",
    "Total backup restores",
    ["result"]
  );
  const stateRevisionGauge = metrics.gauge("state_revision", "Current state revision number");
  const lastReconcileTimestampGauge = metrics.gauge(
    "last_reconcile_timestamp_seconds",
    "Unix timestamp of last reconcile (0 if never)"
  );
  const reconcileDurationSeconds: Histogram = metrics.histogram(
    "reconcile_duration_seconds",
    "Reconcile duration in seconds",
    [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
  );

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

  // Prometheus text-exposition endpoint. Mounted at root, no API token —
  // operators front this with their scraper (and the engine is normally
  // bound to localhost or a private network via KINTUNNEL_ENGINE_PORT).
  app.get("/metrics", async (_req, res, next) => {
    try {
      const state = await store.load();
      // Re-derive dynamic peer counters from current state on every scrape.
      peersTotal.reset();
      peersActive.reset();
      peersRevoked.reset();
      peersTotal.inc(state.peers.length);
      peersActive.inc(state.peers.filter((p) => isPeerActive(p)).length);
      peersRevoked.inc(state.peers.filter((p) => p.status === "revoked").length);
      // Gauges reflect current state too.
      stateRevisionGauge.set(state.revision);
      if (state.lastReconcile && state.lastReconcile.finishedAt) {
        const ts = Date.parse(state.lastReconcile.finishedAt);
        lastReconcileTimestampGauge.set(Number.isFinite(ts) ? ts / 1000 : 0);
      } else {
        lastReconcileTimestampGauge.set(0);
      }
      res.type("text/plain; version=0.0.4").send(metrics.render());
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
      // NEW (P3.4) — lazy expiry sweep on /status. Wrapped so a sweep
      // failure cannot break the status read; reconcile is invoked only
      // when auto-revoke actually changed peer state.
      let expiry = {
        newly_expired: 0,
        auto_revoked: 0,
        expiring_soon: [] as Array<{
          peer_id: string;
          name: string;
          expires_at: string;
          days_remaining: number;
        }>
      };
      try {
        const sweep = await store.sweepExpired({
          autoRevoke: resolved.expiryAutoRevoke,
          warnWithinDays: resolved.expiryWarnDays
        });
        if (sweep.auto_revoked.length > 0) {
          // Push the revoke into the kernel so /status reflects what the
          // running WireGuard interface will see. Best-effort: failures
          // are surfaced via the runtime.error channel without breaking /status.
          try {
            await reconcile(config, await store.load());
          } catch (reconcileError) {
            auditLogger.warn("expiry sweep: post-revoke reconcile failed", {
              error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
            });
          }
        }
        expiry = {
          newly_expired: sweep.expired.length,
          auto_revoked: sweep.auto_revoked.length,
          expiring_soon: sweep.expiring_soon
        };
      } catch (sweepError) {
        auditLogger.warn("expiry sweep failed", {
          error: sweepError instanceof Error ? sweepError.message : String(sweepError)
        });
      }
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
        expiry,
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

  // NEW (P3.4) — list soon-to-expire peers. Reuses the sweep helper with
  // autoRevoke=false so this endpoint is read-only / reporting. `?days=N`
  // overrides the configured warn window; falls back to config when the
  // query param is missing or invalid.
  api.get("/expiring", async (req, res, next) => {
    try {
      const rawDays = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : NaN;
      const days = Number.isInteger(rawDays) && rawDays >= 0 && rawDays <= 365
        ? rawDays
        : resolved.expiryWarnDays;
      const sweep = await store.sweepExpired({
        autoRevoke: false,
        warnWithinDays: days
      });
      res.json({
        expiring_soon: sweep.expiring_soon,
        warn_within_days: days,
        generated_at: new Date().toISOString()
      });
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

  api.get("/audit", async (req, res, next) => {
    try {
      const action = typeof req.query.action === "string" ? req.query.action : undefined;
      const actor = typeof req.query.actor === "string" ? req.query.actor : undefined;
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const limit = limitRaw !== undefined && Number.isInteger(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 5000)
        : 1000;
      const events = await audit.query({ action, actor, since, limit });
      res.json({ events: events.map(sanitizeEvent) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/peers", async (req, res, next) => {
    try {
      const peer = await store.createPeer(req.body);
      peersTotal.inc();
      peersActive.inc();
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
      const { clientConfig } = await store.update((state) => {
        const peer = state.peers.find((candidate) => candidate.id === req.params.id);
        if (!peer || !isPeerActive(peer)) {
          throw new ValidationError("Peer not found.", { id: ["not found or not active"] });
        }

        // appendEvent persists to the durable audit sink synchronously —
        // no separate audit.append() needed here (see StateStore.appendEvent).
        store.appendEvent(state, {
          action: "peer.config.exported",
          targetId: peer.id,
          targetName: peer.name,
          metadata: {
            format: "wireguard",
            status: peerApiStatus(peer)
          }
        });

        return {
          clientConfig: renderClientConfig(peer, state.server)
        };
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
      peersActive.dec();
      peersRevoked.inc();
      res.json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/peers/:id", async (req, res, next) => {
    try {
      // Capture pre-delete status so we know which counter to decrement.
      // deletePeer() also sets `revokedAt` if it was previously unset, so
      // we cannot rely on the post-mutation peer record to tell us whether
      // the peer was active or revoked before deletion.
      const preState = await store.load();
      const prePeer = preState.peers.find((p) => p.id === req.params.id);
      const preStatus = prePeer?.status;

      const peer = await store.deletePeer(req.params.id);
      if (preStatus === "active") {
        peersActive.dec();
      } else if (preStatus === "revoked") {
        peersRevoked.dec();
      }
      res.json({ peer: sanitizePeer(peer) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/reconcile", async (_req, res, next) => {
    try {
      const startedAt = Date.now();
      let reconcileResult;
      try {
        const result = await store.update(async (state) => {
          const r = await reconcile(config, state);
          state.lastReconcile = r;
          state.revision += 1;
          // appendEvent persists to the durable audit sink synchronously —
          // no separate audit.append() needed here (see StateStore.appendEvent).
          store.appendEvent(state, {
            action: "reconcile.completed",
            metadata: {
              ok: r.ok,
              dry_run: r.dryRun,
              applied: r.applied,
              active_peer_count: r.activePeerCount
            }
          });
          return r;
        });
        reconcileResult = result;
      } catch (error) {
        if (error instanceof ApplyError) {
          applyFailuresTotal.inc({ code: error.code });
        }
        throw error;
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      reconcileRunsTotal.inc({ result: reconcileResult.ok ? "ok" : "error" });
      reconcileDurationSeconds.observe(elapsedSeconds);
      stateRevisionGauge.set(reconcileResult.revision);
      res.status(reconcileResult.ok ? 200 : 409).json({ reconcile: reconcileResult });
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
      backupCreatesTotal.inc({ result: "ok" });
      res.status(201).json({ snapshot: summary });
    } catch (error) {
      backupCreatesTotal.inc({ result: "error" });
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
      backupRestoresTotal.inc({ result: "ok" });
      res.json({
        restored: true,
        safety_snapshot_id: result.safetySnapshotId,
        from_revision: result.fromRevision,
        applied: result.applied,
        reconciled: result.reconciled,
        error: result.error
      });
    } catch (error) {
      backupRestoresTotal.inc({ result: "error" });
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

  // ── Person CRUD (P3.1) ───────────────────────────────────────────────────
  // Persons are soft-deleted by default (`status="archived"`). Force-delete
  // cascades through StateStore.deletePerson({ force: true }) and revokes
  // (but does NOT hard-delete) the person's peers so the audit history
  // survives.

  api.get("/persons", async (req, res, next) => {
    try {
      const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
      const status = statusRaw === "active" || statusRaw === "archived" ? statusRaw : undefined;
      const persons = await store.listPersons(status ? { status } : undefined);
      res.json({ persons: persons.map(sanitizePerson) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/persons", async (req, res, next) => {
    try {
      const person = await store.createPerson(req.body);
      res.status(201).json({ person: sanitizePerson(person) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/persons/:id", async (req, res, next) => {
    try {
      const state = await store.load();
      const person = state.persons.find((candidate) => candidate.id === req.params.id);
      if (!person) {
        throw new ValidationError("Person not found.", { id: ["not found"] });
      }
      res.json({ person: sanitizePerson(person) });
    } catch (error) {
      next(error);
    }
  });

  api.patch("/persons/:id", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        displayName?: string;
        display_name?: string;
        notes?: string | null;
        status?: "active" | "archived";
      };
      const patch: {
        displayName?: string;
        notes?: string | null;
        status?: "active" | "archived";
      } = {};
      const rawName = body.displayName ?? body.display_name;
      if (typeof rawName === "string") patch.displayName = rawName;
      // Treat absence vs. null distinctly: missing key = no patch on notes;
      // explicit null = clear notes (matches StateStore.updatePerson contract).
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "notes")) {
        patch.notes = body.notes ?? null;
      }
      if (body.status === "active" || body.status === "archived") {
        patch.status = body.status;
      }
      const person = await store.updatePerson(req.params.id, patch);
      res.json({ person: sanitizePerson(person) });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/persons/:id", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { force?: boolean };
      const force = body.force === true;
      // If the caller is not forcing the cascade, refuse when the person
      // still owns active (non-revoked, non-deleted) peers. Surfacing 409
      // lets the admin UI prompt the operator to use force=true (which
      // revokes peers) or revoke explicitly first.
      if (!force) {
        const state = await store.load();
        const activePeers = state.peers.filter(
          (peer) => peer.personId === req.params.id && peer.status !== "revoked" && peer.status !== "deleted"
        );
        if (activePeers.length > 0) {
          res.status(409).json({
            error: {
              code: "person_has_active_devices",
              message: "Person has active devices; retry with force=true to revoke them.",
              fields: { force: ["required when active devices are present"] }
            }
          });
          return;
        }
      }
      const person = await store.deletePerson(req.params.id, { force });
      res.json({ person: sanitizePerson(person) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/persons/:id/devices", async (req, res, next) => {
    try {
      const state = await store.load();
      const person = state.persons.find((candidate) => candidate.id === req.params.id);
      if (!person) {
        throw new ValidationError("Person not found.", { id: ["not found"] });
      }
      const peers = state.peers
        .filter((peer) => peer.personId === person.id && peer.status !== "deleted")
        .map(sanitizePeer);
      res.json({ devices: peers });
    } catch (error) {
      next(error);
    }
  });

  api.post("/persons/:id/revoke-devices", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { actor?: string };
      const actor = typeof body.actor === "string" && body.actor.trim().length > 0 ? body.actor.trim() : "engine";
      const result = await store.revokePersonDevices(req.params.id, actor);
      res.json({
        revoked_count: result.revokedPeerIds.length,
        already_revoked_count: result.alreadyRevoked,
        revoked_peer_ids: result.revokedPeerIds
      });
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
    deleted_at: peer.deletedAt,
    person_id: peer.personId,
    device_label: peer.deviceLabel
  };
}

function sanitizePerson(person: PersonRecord) {
  return {
    id: person.id,
    display_name: person.displayName,
    notes: person.notes,
    status: person.status,
    created_at: person.createdAt,
    updated_at: person.updatedAt
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

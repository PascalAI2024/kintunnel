import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { renderClientConfig } from "./config-render.js";
import { getCapabilities, getRuntimeState, reconcile } from "./runtime.js";
import { StateStore, ValidationError } from "./state.js";
import type { EngineConfig, PeerRecord, ServerSettings } from "./types.js";

export function createApp(config: EngineConfig) {
  const app = express();
  const api = express.Router();
  const store = new StateStore(config);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res, next) => {
    try {
      const capabilities = await getCapabilities(config);
      res.json({
        ok: config.dryRun || capabilities.hasWg,
        service: "kintunnel-engine",
        dry_run: config.dryRun,
        data_dir: config.dataDir,
        messages: capabilities.messages
      });
    } catch (error) {
      next(error);
    }
  });

  api.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "kintunnel-engine",
      dry_run: config.dryRun
    });
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
          active: state.peers.filter((peer) => peer.status === "active").length,
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
      const state = await store.load();
      const peer = state.peers.find((candidate) => candidate.id === req.params.id);
      if (!peer || peer.status !== "active") {
        throw new ValidationError("Peer not found.", { id: ["not found or not active"] });
      }

      res.type("text/plain").send(renderClientConfig(peer, state.server));
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
        return reconcileResult;
      });
      res.status(result.ok ? 200 : 409).json({ reconcile: result });
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
    status: peer.status,
    expires_at: peer.expiresAt,
    created_at: peer.createdAt,
    updated_at: peer.updatedAt,
    revoked_at: peer.revokedAt,
    deleted_at: peer.deletedAt
  };
}

function sanitizeServer(server: ServerSettings) {
  const { serverPrivateKey: _serverPrivateKey, ...safeServer } = server;
  return safeServer;
}

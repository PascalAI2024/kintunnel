import express from "express";
import { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../packages/admin/src/app";
import type { AdminConfig } from "../../packages/admin/src/config";

const config: AdminConfig = {
  bind: "127.0.0.1",
  port: 0,
  engineUrl: "http://127.0.0.1:0",
  adminToken: "test-token",
  env: "test"
};

describe("admin app", () => {
  let engineServer: ReturnType<express.Express["listen"]>;
  let engineUrl: string;
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  beforeEach(async () => {
    calls.length = 0;
    const engine = express();
    engine.use(express.json());
    engine.get("/api/v1/status", (_req, res) => {
      calls.push({ method: "GET", path: "/api/v1/status" });
      res.json({
        ok: true,
        ready: true,
        revision: 1,
        dry_run: true,
        interface: { name: "wg0", listen_port: 51820, up: true },
        server: { interfaceName: "wg0" },
        peers: { total: 1, active: 1, revoked: 0, deleted: 0 },
        runtime: { interfaceName: "wg0", exists: true, peers: [] },
        checked_at: "2026-05-17T00:00:00.000Z"
      });
    });
    engine.get("/api/v1/peers", (_req, res) => {
      calls.push({ method: "GET", path: "/api/v1/peers" });
      res.json({ peers: [{ id: "peer-1", name: "alice-phone", status: "active", address_v4: "10.44.0.2/32" }] });
    });
    engine.post("/api/v1/peers", (req, res) => {
      calls.push({ method: "POST", path: "/api/v1/peers", body: req.body });
      res.status(201).json({ peer: { id: "peer-2", name: req.body.name, status: "active" } });
    });
    engine.get("/api/v1/peers/:id", (req, res) => {
      calls.push({ method: "GET", path: `/api/v1/peers/${req.params.id}` });
      if (req.params.id === "missing") {
        res.status(404).json({ error: { code: "not_found", message: "Peer not found." } });
        return;
      }
      res.json({ peer: { id: req.params.id, name: "alice-phone", status: "active", address_v4: "10.44.0.2/32" } });
    });
    engine.get("/v1/peers/:id", (req, res) => {
      calls.push({ method: "GET", path: `/v1/peers/${req.params.id}` });
      res.json({ peer: { id: req.params.id, name: "legacy-peer", status: "active" } });
    });
    engine.get("/api/v1/peers/:id/config", (req, res) => {
      calls.push({ method: "GET", path: `/api/v1/peers/${req.params.id}/config` });
      res.type("text/plain").send("[Interface]\nPrivateKey = SECRET\nAddress = 10.44.0.2/32\n");
    });
    engine.post("/api/v1/peers/:id/revoke", (req, res) => {
      calls.push({ method: "POST", path: `/api/v1/peers/${req.params.id}/revoke` });
      res.status(204).send();
    });
    engine.delete("/api/v1/peers/:id", (req, res) => {
      calls.push({ method: "DELETE", path: `/api/v1/peers/${req.params.id}` });
      res.status(204).send();
    });

    await new Promise<void>((resolve, reject) => {
      engineServer = engine.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    const address = engineServer.address() as AddressInfo;
    engineUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      engineServer.close((error) => error ? reject(error) : resolve());
    });
  });

  it("requires authentication for the dashboard", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/");

    expect(response.status).toBe(302);
    expect(response.header.location).toBe("/login");
  });

  it("renders peer list for authenticated admins", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.text).toContain("alice-phone");
    expect(response.text).toContain("wg0");
  });

  it("creates peers through the engine", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app)
      .post("/peers")
      .set("Authorization", "Bearer test-token")
      .type("form")
      .send({ name: "bob-laptop", generate_keys: "true", allowed_ips: "0.0.0.0/0, ::/0" });

    expect(response.status).toBe(302);
    expect(response.header.location).toBe("/peers/peer-2");
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/v1/peers",
      body: { name: "bob-laptop", generate_keys: true, allowed_ips: ["0.0.0.0/0", "::/0"] }
    });
  });

  it("renders peer config and QR without logging the config body", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/peers/peer-1").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.text).toContain("PrivateKey = SECRET");
    expect(response.text).toContain("data:image/png;base64");
    expect(calls.map((call) => call.body)).not.toContain("[Interface]\nPrivateKey = SECRET\nAddress = 10.44.0.2/32\n");
  });

  it("revokes and deletes peers through the engine", async () => {
    const app = createApp({ config: { ...config, engineUrl } });

    await request(app).post("/peers/peer-1/revoke").set("Authorization", "Bearer test-token").expect(302);
    await request(app).post("/peers/peer-1/delete").set("Authorization", "Bearer test-token").expect(302);

    expect(calls).toContainEqual({ method: "POST", path: "/api/v1/peers/peer-1/revoke" });
    expect(calls).toContainEqual({ method: "DELETE", path: "/api/v1/peers/peer-1" });
  });

  it("does not hide domain 404 errors with legacy-path fallback", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    await request(app).get("/peers/missing").set("Authorization", "Bearer test-token").expect(502);

    expect(calls).toContainEqual({ method: "GET", path: "/api/v1/peers/missing" });
    expect(calls).not.toContainEqual({ method: "GET", path: "/v1/peers/missing" });
  });
});

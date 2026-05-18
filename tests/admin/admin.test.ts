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
  engineApiToken: "engine-token",
  engineTimeoutMs: 5000,
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
    engine.get("/api/v1/events", (_req, res) => {
      calls.push({ method: "GET", path: "/api/v1/events" });
      res.json({ events: [{ id: "event-1", action: "peer.created", target_name: "alice-phone", revision: 2, created_at: "2026-05-17T00:00:00.000Z" }] });
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
    expect(response.text).toContain("peer created");
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

  it("does not render or fetch peer config and QR on peer detail", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/peers/peer-1").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("PrivateKey = SECRET");
    expect(response.text).not.toContain("data:image/png;base64");
    expect(response.text).toContain("Download config");
    expect(response.text).toContain("Open QR");
    expect(calls).toContainEqual({ method: "GET", path: "/api/v1/peers/peer-1" });
    expect(calls).not.toContainEqual({ method: "GET", path: "/api/v1/peers/peer-1/config" });
  });

  it("downloads peer config as an attachment", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/peers/peer-1/config.conf").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.header["content-disposition"]).toContain("alice-phone.conf");
    expect(response.text).toContain("PrivateKey = SECRET");
  });

  it("renders peer QR only on explicit request", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const response = await request(app).get("/peers/peer-1/config.png").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.header["content-type"]).toContain("image/png");
    expect(response.header["content-disposition"]).toContain("alice-phone-qr.png");
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.length).toBeGreaterThan(0);
    expect(calls).toContainEqual({ method: "GET", path: "/api/v1/peers/peer-1/config" });
  });

  it("requires CSRF for cookie-authenticated peer creation", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const agent = request.agent(app);

    await agent.post("/login").type("form").send({ token: "test-token" }).expect(302);
    await agent.post("/peers").type("form").send({ name: "csrf-missing" }).expect(403);
    expect(calls).not.toContainEqual({
      method: "POST",
      path: "/api/v1/peers",
      body: { name: "csrf-missing" }
    });

    const form = await agent.get("/peers/new").expect(200);
    const csrfToken = extractCsrfToken(form.text);
    await agent.post("/peers").type("form").send({ _csrf: csrfToken, name: "cookie-peer" }).expect(302);

    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/v1/peers",
      body: { name: "cookie-peer" }
    });
  });

  it("requires CSRF for cookie-authenticated logout", async () => {
    const app = createApp({ config: { ...config, engineUrl } });
    const agent = request.agent(app);

    await agent.post("/login").type("form").send({ token: "test-token" }).expect(302);
    await agent.post("/logout").type("form").send({}).expect(403);

    const dashboard = await agent.get("/").expect(200);
    const csrfToken = extractCsrfToken(dashboard.text);
    const logout = await agent.post("/logout").type("form").send({ _csrf: csrfToken }).expect(302);
    expect(logout.header.location).toBe("/login");
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

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

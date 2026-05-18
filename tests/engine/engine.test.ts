import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../packages/engine/src/app.js";
import { loadConfig } from "../../packages/engine/src/env.js";
import { StateStore } from "../../packages/engine/src/state.js";
import type { EngineConfig } from "../../packages/engine/src/types.js";

describe("KinTunnel engine MVP", () => {
  let tempDir: string;
  let config: EngineConfig;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kintunnel-engine-"));
    config = loadConfig({
      env: "test",
      dryRun: true,
      dataDir: tempDir,
      statePath: path.join(tempDir, "state.json"),
      apiToken: "engine-token",
      tunnelCidrV4: "10.55.0.0/29",
      endpointHost: "vpn.example.test",
      defaultDnsServers: ["10.55.0.1"]
    });

    server = createApp(config).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates and persists initial state", async () => {
    const store = new StateStore(config);
    const state = await store.load();
    const reloaded = await store.load();

    expect(state.version).toBe(1);
    expect(state.server.interfaceName).toBe("wg0");
    expect(state.server.serverAddressV4).toBe("10.55.0.1/32");
    expect(reloaded.server.serverPublicKey).toBe(state.server.serverPublicKey);
  });

  it("enforces strong engine API tokens in production", () => {
    expect(() =>
      loadConfig({
        env: "production",
        dryRun: true,
        dataDir: tempDir,
        statePath: path.join(tempDir, "state.json"),
        apiToken: "engine-token"
      })
    ).toThrow(/generated secret/);

    expect(() => createApp({ ...config, env: "production", apiToken: "engine-token" })).toThrow(/generated secret/);
    expect(() => createApp({ ...config, env: "production", apiToken: "ak_7Zp4Qw9Rt2Yu6Io8Pa3Sd5Fg1Hj0KlXc" })).not.toThrow();
  });

  it("keeps unauthenticated health output free of local paths", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("data_dir");
    expect(body).not.toHaveProperty("state_path");
  });

  it("creates peers and allocates deterministic tunnel addresses", async () => {
    const first = await postJson("/v1/peers", { name: "alice-phone" });
    const second = await postJson("/v1/peers", { name: "bob-laptop" });
    const list = await getJson("/v1/peers");
    const status = await getJson("/v1/status");
    const events = await getJson("/v1/events?limit=10");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.peer.address_v4).toBe("10.55.0.2/32");
    expect(second.body.peer.address_v4).toBe("10.55.0.3/32");
    expect(list.body.peers).toHaveLength(2);
    expect(list.body.peers[0].private_key).toBeUndefined();
    expect(status.body.interface.name).toBe("wg0");
    expect(status.body.peers.active).toBe(2);
    expect(events.body.events.map((event: { action: string }) => event.action)).toContain("peer.created");
  });

  it("serializes concurrent peer creation to avoid duplicate tunnel addresses", async () => {
    const results = await Promise.all(
      ["phone", "tablet", "laptop", "desktop"].map((name) => postJson("/v1/peers", { name }))
    );
    const peers = results.map((result) => result.body.peer);
    const addresses = peers.map((peer) => peer.address_v4);

    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toEqual(["10.55.0.2/32", "10.55.0.3/32", "10.55.0.4/32", "10.55.0.5/32"]);
  });

  it("rejects duplicate peer names and unknown fields", async () => {
    await postJson("/v1/peers", { name: "alice-phone" });
    const duplicate = await postJson("/v1/peers", { name: "alice-phone" });
    const unknown = await postJson("/v1/peers", { name: "mallory", shell: "rm -rf /" });

    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.fields.name).toEqual(["must be unique"]);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.fields.unknown_fields).toEqual(["shell is not allowed"]);
  });

  it("validates peer input before persisting", async () => {
    const shortName = await postJson("/v1/peers", { name: "a" });
    const badName = await postJson("/v1/peers", { name: "bad\nname" });
    const badKey = await postJson("/v1/peers", { name: "alice-phone", public_key: "not-a-key", generate_keys: false });
    const badAllowedIp = await postJson("/v1/peers", { name: "bob-laptop", allowed_ips: ["not-a-cidr"] });

    expect(shortName.status).toBe(201);
    expect(badName.status).toBe(400);
    expect(badKey.status).toBe(400);
    expect(badAllowedIp.status).toBe(400);
  });

  it("renders WireGuard client config for active generated peers", async () => {
    const created = await postJson("/v1/peers", {
      name: "alice-phone",
      allowed_ips: ["10.0.0.0/8"],
      dns_servers: ["9.9.9.9"]
    });

    const configResponse = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}/config`, { headers: authHeaders() });
    const text = await configResponse.text();

    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("content-type")).toContain("text/plain");
    expect(configResponse.headers.get("cache-control")).toContain("no-store");
    expect(text).toContain("[Interface]");
    expect(text).toContain("Address = 10.55.0.2/32");
    expect(text).toContain("DNS = 9.9.9.9");
    expect(text).toContain("[Peer]");
    expect(text).toContain("Endpoint = vpn.example.test:51820");
    expect(text).toContain("AllowedIPs = 10.0.0.0/8");

    const events = await getJson("/v1/events?limit=10");
    const exportEvent = events.body.events.find((event: { action: string }) => event.action === "peer.config.exported");
    expect(exportEvent).toMatchObject({
      target_id: created.body.peer.id,
      target_name: "alice-phone",
      metadata: {
        format: "wireguard",
        status: "active"
      }
    });
    expect(JSON.stringify(exportEvent.metadata)).not.toContain("PrivateKey");
  });

  it("soft-deletes peers, revokes config access, and excludes them from reconcile", async () => {
    const created = await postJson("/v1/peers", { name: "alice-phone" });
    const deleted = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}`, { method: "DELETE", headers: authHeaders() });
    const deletedBody = await deleted.json();
    const configResponse = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}/config`, { headers: authHeaders() });
    const reconcile = await postJson("/v1/reconcile", {});

    expect(deleted.status).toBe(200);
    expect(deletedBody.peer.status).toBe("deleted");
    expect(deletedBody.peer.revoked_at).toBeTruthy();
    expect(configResponse.status).toBe(404);
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.reconcile.applied).toBe(true);
    expect(reconcile.body.reconcile.activePeerCount).toBe(0);
    const events = await getJson("/v1/events");
    expect(events.body.events.map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining(["peer.deleted", "reconcile.completed"])
    );
  });

  it("treats expired peers as inactive for config export and reconcile", async () => {
    const created = await postJson("/v1/peers", { name: "temporary-phone" });
    const store = new StateStore(config);
    const state = await store.load();
    const peer = state.peers.find((candidate) => candidate.id === created.body.peer.id);
    if (!peer) throw new Error("Expected created peer in state.");
    peer.expiresAt = "2020-01-01T00:00:00.000Z";
    await store.save(state);

    const detail = await getJson(`/v1/peers/${created.body.peer.id}`);
    const configResponse = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}/config`, { headers: authHeaders() });
    const reconcile = await postJson("/v1/reconcile", {});

    expect(detail.body.peer.status).toBe("expired");
    expect(configResponse.status).toBe(404);
    expect(reconcile.body.reconcile.activePeerCount).toBe(0);
  });

  it("requires an engine API token for versioned routes", async () => {
    const response = await fetch(`${baseUrl}/v1/status`);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  async function getJson(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: authHeaders() });
    return {
      status: response.status,
      body: await response.json()
    };
  }

  async function postJson(pathname: string, body: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    return {
      status: response.status,
      body: await response.json()
    };
  }
});

function authHeaders() {
  return { authorization: "Bearer engine-token" };
}

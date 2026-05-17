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
      dryRun: true,
      dataDir: tempDir,
      statePath: path.join(tempDir, "state.json"),
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

  it("creates peers and allocates deterministic tunnel addresses", async () => {
    const first = await postJson("/v1/peers", { name: "alice-phone" });
    const second = await postJson("/v1/peers", { name: "bob-laptop" });
    const list = await getJson("/v1/peers");
    const status = await getJson("/v1/status");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.peer.address_v4).toBe("10.55.0.2/32");
    expect(second.body.peer.address_v4).toBe("10.55.0.3/32");
    expect(list.body.peers).toHaveLength(2);
    expect(list.body.peers[0].private_key).toBeUndefined();
    expect(status.body.interface.name).toBe("wg0");
    expect(status.body.peers.active).toBe(2);
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

  it("renders WireGuard client config for active generated peers", async () => {
    const created = await postJson("/v1/peers", {
      name: "alice-phone",
      allowed_ips: ["10.0.0.0/8"],
      dns_servers: ["9.9.9.9"]
    });

    const configResponse = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}/config`);
    const text = await configResponse.text();

    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("[Interface]");
    expect(text).toContain("Address = 10.55.0.2/32");
    expect(text).toContain("DNS = 9.9.9.9");
    expect(text).toContain("[Peer]");
    expect(text).toContain("Endpoint = vpn.example.test:51820");
    expect(text).toContain("AllowedIPs = 10.0.0.0/8");
  });

  it("soft-deletes peers, revokes config access, and excludes them from reconcile", async () => {
    const created = await postJson("/v1/peers", { name: "alice-phone" });
    const deleted = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}`, { method: "DELETE" });
    const deletedBody = await deleted.json();
    const configResponse = await fetch(`${baseUrl}/v1/peers/${created.body.peer.id}/config`);
    const reconcile = await postJson("/v1/reconcile", {});

    expect(deleted.status).toBe(200);
    expect(deletedBody.peer.status).toBe("deleted");
    expect(deletedBody.peer.revoked_at).toBeTruthy();
    expect(configResponse.status).toBe(404);
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.reconcile.applied).toBe(true);
    expect(reconcile.body.reconcile.activePeerCount).toBe(0);
  });

  async function getJson(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`);
    return {
      status: response.status,
      body: await response.json()
    };
  }

  async function postJson(pathname: string, body: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    return {
      status: response.status,
      body: await response.json()
    };
  }
});

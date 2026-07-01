import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpEngineClient } from "../../packages/admin/src/engine-client";

describe("engine process with admin HTTP client", () => {
  let tempDir: string;
  let port: number;
  let engine: ChildProcessWithoutNullStreams;
  let output: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kintunnel-integration-"));
    port = await getAvailablePort();
    output = "";

    engine = spawn(process.execPath, ["--import", "tsx", path.resolve("packages/engine/src/index.ts")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        KINTUNNEL_ENV: "test",
        KINTUNNEL_DRY_RUN: "true",
        KINTUNNEL_ENGINE_PORT: String(port),
        KINTUNNEL_ENGINE_API_TOKEN: "engine-token",
        KINTUNNEL_DATA_DIR: tempDir,
        KINTUNNEL_ENDPOINT_HOST: "vpn.integration.test",
        KINTUNNEL_ENDPOINT_PORT: "51820",
        KINTUNNEL_WG_ADDRESS: "10.77.0.0/29",
        KINTUNNEL_DNS_SERVERS: "10.77.0.1"
      },
      windowsHide: true
    });

    engine.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    engine.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    await waitForEngine(`http://127.0.0.1:${port}`, engine, () => output);
  });

  afterEach(async () => {
    await stopProcess(engine);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates, reads, renders, revokes, and deletes a peer through HttpEngineClient", async () => {
    const client = new HttpEngineClient(`http://127.0.0.1:${port}`);
    client.configure({ apiToken: "engine-token" });

    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.dry_run).toBe(true);

    const created = await client.createPeer({
      name: "integration-phone",
      allowed_ips: ["0.0.0.0/0"],
      dns_servers: ["10.77.0.1"]
    });
    expect(created.name).toBe("integration-phone");
    expect(created.status).toBe("active");
    expect(created.address_v4).toBe("10.77.0.2/32");

    const listed = await client.listPeers();
    expect(listed.map((peer) => peer.id)).toContain(created.id);

    const fetched = await client.getPeer(created.id);
    expect(fetched).toMatchObject({
      id: created.id,
      name: "integration-phone",
      status: "active"
    });

    const config = await client.getPeerConfig(created.id);
    expect(config).toContain("[Interface]");
    expect(config).toContain("Address = 10.77.0.2/32");
    expect(config).toContain("DNS = 10.77.0.1");
    expect(config).toContain("Endpoint = vpn.integration.test:51820");

    await client.revokePeer(created.id);
    const revoked = await client.getPeer(created.id);
    expect(revoked.status).toBe("revoked");
    await expect(client.getPeerConfig(created.id)).rejects.toMatchObject({ statusCode: 404 });

    await client.deletePeer(created.id);
    await expect(client.getPeer(created.id)).rejects.toMatchObject({ statusCode: 404 });

    const status = await client.status();
    expect(status.peers).toMatchObject({
      total: 1,
      active: 0,
      revoked: 0,
      deleted: 1
    });
  });

  it("creates, reads, updates, and deletes a person through HttpEngineClient", async () => {
    const client = new HttpEngineClient(`http://127.0.0.1:${port}`);
    client.configure({ apiToken: "engine-token" });

    const created = await client.createPerson({ displayName: "Integration Alice", notes: "test person" });
    expect(created.id).toBeDefined();
    expect(created.display_name).toBe("Integration Alice");
    expect(created.status).toBe("active");

    const listed = await client.listPersons();
    expect(listed.map((person) => person.id)).toContain(created.id);

    const fetched = await client.getPerson(created.id);
    expect(fetched).toMatchObject({ id: created.id, display_name: "Integration Alice" });

    const devices = await client.listPersonDevices(created.id);
    expect(devices).toEqual([]);

    const updated = await client.updatePerson(created.id, { displayName: "Integration Alice Updated" });
    expect(updated.display_name).toBe("Integration Alice Updated");

    const deleted = await client.deletePerson(created.id);
    expect(deleted.status).toBe("archived");

    const afterDelete = await client.getPerson(created.id);
    expect(afterDelete.status).toBe("archived");

    const activeOnly = await client.listPersons({ status: "active" });
    expect(activeOnly.map((person) => person.id)).not.toContain(created.id);
  });
});

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForEngine(baseUrl: string, process: ChildProcessWithoutNullStreams, getOutput: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let exitCode: number | null = null;
  process.once("exit", (code) => {
    exitCode = code;
  });

  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(`Engine exited before readiness with code ${exitCode}.\n${getOutput()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the process starts listening.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for engine readiness.\n${getOutput()}`);
}

async function stopProcess(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 2_000);

    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill();
  });
}

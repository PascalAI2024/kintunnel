import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPeerActive } from "./peers.js";
import type { EngineConfig, EngineState, ReconcileResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface Capabilities {
  platform: NodeJS.Platform;
  dryRun: boolean;
  hasWg: boolean;
  hasWgQuick: boolean;
  hasTun: boolean;
  canInspectInterface: boolean;
  interfaceName: string;
  messages: string[];
}

export interface RuntimeState {
  interfaceName: string;
  exists: boolean;
  listenPort?: number;
  peers: Array<{
    publicKey: string;
    endpoint?: string;
    allowedIps: string[];
    latestHandshakeAt?: string;
    transferRxBytes?: number;
    transferTxBytes?: number;
  }>;
  rawAvailable: boolean;
}

export async function getCapabilities(config: EngineConfig): Promise<Capabilities> {
  const messages: string[] = [];
  const hasWg = config.dryRun ? true : await commandExists("wg");
  const hasWgQuick = config.dryRun ? true : await commandExists("wg-quick");
  const hasTun = config.dryRun || process.platform !== "linux" ? config.dryRun : await pathExists("/dev/net/tun");
  let canInspectInterface = config.dryRun;

  if (!config.dryRun && hasWg) {
    canInspectInterface = await canRun("wg", ["show", config.interfaceName]);
  }

  if (!config.dryRun && process.platform !== "linux") {
    messages.push("Non-dry-run WireGuard runtime management is intended for Linux hosts.");
  }
  if (!hasWg) messages.push("wg command is not available.");
  if (!hasWgQuick) messages.push("wg-quick command is not available.");
  if (!hasTun) messages.push("/dev/net/tun is not available.");

  return {
    platform: process.platform,
    dryRun: config.dryRun,
    hasWg,
    hasWgQuick,
    hasTun,
    canInspectInterface,
    interfaceName: config.interfaceName,
    messages
  };
}

export async function getRuntimeState(config: EngineConfig, state: EngineState): Promise<RuntimeState> {
  if (config.dryRun) {
    return {
      interfaceName: state.server.interfaceName,
      exists: true,
      listenPort: state.server.listenPort,
      peers: state.peers
        .filter((peer) => isPeerActive(peer))
        .map((peer) => ({
          publicKey: peer.publicKey,
          allowedIps: [peer.addressV4]
        })),
      rawAvailable: false
    };
  }

  try {
    const { stdout } = await execFileAsync("wg", ["show", state.server.interfaceName, "dump"], { windowsHide: true });
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean);
    const [interfaceRow, ...peerRows] = rows;
    const listenPort = interfaceRow?.split("\t")[2];

    return {
      interfaceName: state.server.interfaceName,
      exists: rows.length > 0,
      listenPort: listenPort ? Number.parseInt(listenPort, 10) : undefined,
      peers: peerRows.map((row) => {
        const columns = row.split("\t");
        const handshake = Number.parseInt(columns[4] ?? "0", 10);
        return {
          publicKey: columns[0] ?? "",
          endpoint: columns[2] || undefined,
          allowedIps: (columns[3] ?? "").split(",").filter(Boolean),
          latestHandshakeAt: handshake > 0 ? new Date(handshake * 1000).toISOString() : undefined,
          transferRxBytes: Number.parseInt(columns[5] ?? "0", 10),
          transferTxBytes: Number.parseInt(columns[6] ?? "0", 10)
        };
      }),
      rawAvailable: true
    };
  } catch {
    return {
      interfaceName: state.server.interfaceName,
      exists: false,
      peers: [],
      rawAvailable: false
    };
  }
}

export async function reconcile(config: EngineConfig, state: EngineState): Promise<ReconcileResult> {
  const startedAt = new Date().toISOString();
  const messages: string[] = [];
  const errors: string[] = [];
  const activePeers = state.peers.filter((peer) => isPeerActive(peer));

  const publicKeys = new Set<string>();
  const addresses = new Set<string>();
  for (const peer of activePeers) {
    if (publicKeys.has(peer.publicKey)) errors.push(`Duplicate peer public key: ${peer.name}`);
    if (addresses.has(peer.addressV4)) errors.push(`Duplicate peer address: ${peer.addressV4}`);
    publicKeys.add(peer.publicKey);
    addresses.add(peer.addressV4);
  }

  let applied = false;
  if (errors.length === 0 && config.dryRun) {
    applied = true;
    messages.push("Dry-run reconcile validated intended state without touching host networking.");
  } else if (errors.length === 0) {
    const capabilities = await getCapabilities(config);
    if (!capabilities.hasWg || !capabilities.hasWgQuick || !capabilities.hasTun) {
      errors.push(...capabilities.messages);
    } else {
      const runtime = await getRuntimeState(config, state);
      if (!runtime.exists) {
        errors.push(
          `Interface ${state.server.interfaceName} is not running. Conservative MVP did not call wg-quick up automatically.`
        );
      } else {
        messages.push("WireGuard interface exists; runtime inspection succeeded.");
        messages.push("Peer replacement is intentionally deferred until host networking policy is finalized.");
        applied = false;
      }
    }
  }

  return {
    ok: errors.length === 0,
    dryRun: config.dryRun,
    applied,
    revision: state.revision,
    interfaceName: state.server.interfaceName,
    activePeerCount: activePeers.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    messages,
    errors
  };
}

async function commandExists(command: string): Promise<boolean> {
  return canRun(command, ["--version"]);
}

async function canRun(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.access(target));
    return true;
  } catch {
    return false;
  }
}

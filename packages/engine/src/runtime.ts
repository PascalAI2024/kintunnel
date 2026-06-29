import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ApplyError, executeApply } from "./apply.js";
import { applyNetworking, NetworkingError, planNetworking } from "./networking.js";
import { isPeerActive } from "./peers.js";
import type {
  ApplyRequest,
  ApplyResult,
  Capabilities,
  EngineConfig,
  EngineState,
  NetworkingResult,
  ReconcileResult
} from "./types.js";

const execFileAsync = promisify(execFile);

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
    persistentKeepalive?: number;
  }>;
  rawAvailable: boolean;
}

export async function getCapabilities(config: EngineConfig): Promise<Capabilities> {
  const messages: string[] = [];
  const hasWg = config.dryRun ? true : await commandExists("wg");
  const hasWgQuick = config.dryRun ? true : await commandExists("wg-quick");
  const hasTun = config.dryRun || process.platform !== "linux" ? config.dryRun : await pathExists("/dev/net/tun");
  const hasIptables = config.dryRun ? true : await commandExists("iptables");
  // KinTunnel does not depend on ipset today — surface as always-false so the
  // orchestrator does not plan around capabilities the engine will not exercise.
  const hasIpset = false;
  let canInspectInterface = config.dryRun;
  let ipForward: boolean | undefined;

  if (!config.dryRun && hasWg) {
    canInspectInterface = await canRun("wg", ["show", config.interfaceName]);
  }

  if (!config.dryRun) {
    ipForward = await readIpForward();
    if (hasIptables) {
      const natListOk = await canRun("iptables", ["-t", "nat", "-L", "-n"]);
      if (!natListOk) {
        messages.push("iptables nat table is not inspectable; networking policy will be skipped.");
      }
    } else {
      messages.push("iptables is not available; networking policy will be skipped.");
    }
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
    hasIptables,
    hasIpset,
    hasTun,
    canInspectInterface,
    interfaceName: config.interfaceName,
    ipForward,
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
        // Column 7 in `wg show <iface> dump` is the persistent keepalive
        // interval in seconds, or the literal string "off" when disabled.
        const keepaliveRaw = columns[7]?.trim();
        const keepaliveParsed = keepaliveRaw && keepaliveRaw !== "off" ? Number.parseInt(keepaliveRaw, 10) : NaN;
        const persistentKeepalive = Number.isNaN(keepaliveParsed) ? undefined : keepaliveParsed;
        return {
          publicKey: columns[0] ?? "",
          endpoint: columns[2] || undefined,
          allowedIps: (columns[3] ?? "").split(",").filter(Boolean),
          latestHandshakeAt: handshake > 0 ? new Date(handshake * 1000).toISOString() : undefined,
          transferRxBytes: Number.parseInt(columns[5] ?? "0", 10),
          transferTxBytes: Number.parseInt(columns[6] ?? "0", 10),
          persistentKeepalive
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
  let applyResult: ApplyResult | undefined;
  let networkingResult: NetworkingResult | undefined;
  let actionsExecuted: string[] | undefined;
  if (errors.length === 0 && config.dryRun) {
    applied = true;
    messages.push("Dry-run reconcile validated intended state without touching host networking.");
  } else if (errors.length === 0) {
    const capabilities = await getCapabilities(config);
    if (!capabilities.hasWg || !capabilities.hasWgQuick || !capabilities.hasTun) {
      errors.push(...capabilities.messages);
    } else {
      try {
        const req: ApplyRequest = { state, dryRun: false };
        applyResult = await executeApply(req);
        applied = applyResult.applied;
        actionsExecuted = applyResult.actionsExecuted;
        messages.push(...applyResult.messages);
        errors.push(...applyResult.errors);
      } catch (error) {
        if (error instanceof ApplyError) {
          errors.push(`${error.code}: ${error.message}`);
        } else {
          throw error;
        }
      }
    }
  }

  // Networking policy (Wave 3 / P1.2). Runs after apply — including in dry-run
  // mode — so the policy is exercised every reconcile. `applyNetworking`
  // internally skips when `!natEnabled || !natApply`; we still let it run in
  // dry-run because the documented contract is "skip when natApply=false",
  // not "skip when dryRun=true". Errors flow into result.errors[] so a
  // networking regression surfaces alongside WireGuard regressions.
  if (applied) {
    try {
      const plan = planNetworking(config, state);
      networkingResult = await applyNetworking(config, plan, state);
      messages.push(...networkingResult.warnings);
      errors.push(...networkingResult.errors);
    } catch (error) {
      if (error instanceof NetworkingError) {
        errors.push(`${error.code}: ${error.message}`);
      } else {
        throw error;
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
    errors,
    apply: applyResult,
    networking: networkingResult,
    actionsExecuted
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

async function readIpForward(): Promise<boolean | undefined> {
  // Never throw — capability probe must degrade gracefully on non-Linux or
  // locked-down hosts where /proc/sys/net/ipv4/ip_forward is unreadable.
  try {
    const raw = (await readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
    return raw === "1";
  } catch {
    return undefined;
  }
}

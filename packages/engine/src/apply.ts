import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPeerActive } from "./peers.js";
import { withFileLock } from "./state.js";
import type {
  ApplyPlan,
  ApplyRequest,
  ApplyResult,
  AuditAction,
  EngineConfig,
  EngineState,
  PeerRecord
} from "./types.js";
import { getRuntimeState } from "./runtime.js";
import type { RuntimeState } from "./runtime.js";

export type ApplyErrorCode =
  | "capability_missing"
  | "interface_exists"
  | "interface_missing"
  | "duplicate_address"
  | "duplicate_pubkey"
  | "key_format_invalid"
  | "bootstrap_timeout"
  | "syncconf_failed"
  | "peer_remove_failed"
  | "drift_unrecoverable"
  | "dry_run_only";

const execFileAsync = promisify(execFile);

const APPLY_LOCK_PATH = "/var/run/kintunnel-apply.lock";
const APPLY_LOCK_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = 30_000;
const TEMP_INI_DIR = "/var/run/kintunnel";
const TEMP_INI_MODE = 0o600;
const DEFAULT_MTU = 1420;

export class ApplyError extends Error {
  public readonly code: ApplyErrorCode;
  public readonly detail: Record<string, string | number | boolean>;

  constructor(
    code: ApplyErrorCode,
    message: string,
    detail: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = "ApplyError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Compute what changes are needed to bring the runtime in line with intended
 * state. Pure function — no I/O. The caller pairs this with `executeApply` to
 * actually perform the work; tests can exercise `planApply` directly without
 * touching host networking.
 */
export function planApply(state: EngineState, runtime: RuntimeState): ApplyPlan {
  const activePeers = state.peers.filter((peer) => isPeerActive(peer));
  const intendedPublicKeys = new Set(activePeers.map((peer) => peer.publicKey));
  const currentPublicKeys = new Set(runtime.peers.map((peer) => peer.publicKey));

  const addPeers: string[] = [];
  const removePeers: string[] = [];
  const modifyPeers: string[] = [];

  for (const pubKey of intendedPublicKeys) {
    if (!currentPublicKeys.has(pubKey)) addPeers.push(pubKey);
  }
  for (const pubKey of currentPublicKeys) {
    if (!intendedPublicKeys.has(pubKey)) removePeers.push(pubKey);
  }

  const bootstrap = !runtime.exists;
  const reconfigureInterface =
    !bootstrap &&
    runtime.exists &&
    (runtime.listenPort ?? -1) !== state.server.listenPort;

  return {
    bootstrap,
    reconfigureInterface,
    addPeers,
    removePeers,
    modifyPeers
  };
}

/**
 * Diff intended vs current peer set. Exported so the dry-run path can produce
 * the same diagnostics the live path consumes; tests can exercise this without
 * any host exec. Field names match the live `ApplyPlan` (add/remove/modify) so
 * the reconciliation of fields between the two surfaces is mechanical.
 */
export async function diffPeers(
  intended: PeerRecord[],
  currentPublicKeys: Set<string>
): Promise<{ add: string[]; remove: string[]; modify: string[] }> {
  const intendedPublicKeys = new Set(intended.map((peer) => peer.publicKey));
  const add: string[] = [];
  const remove: string[] = [];
  const modify: string[] = [];

  for (const pubKey of intendedPublicKeys) {
    if (!currentPublicKeys.has(pubKey)) add.push(pubKey);
  }
  for (const pubKey of currentPublicKeys) {
    if (!intendedPublicKeys.has(pubKey)) remove.push(pubKey);
  }

  return { add, remove, modify };
}

/**
 * Render a WireGuard INI block. `activeOnly` filters to peers that the runtime
 * would actually serve (`isPeerActive`). The bootstrap path uses an inline
 * `[Interface]`-only INI rather than this function because `wg setconf`
 * during bootstrap must not include any peer sections.
 */
export function renderWgIni(state: EngineState, activeOnly: boolean): string {
  const lines: string[] = [
    "[Interface]",
    `PrivateKey = ${state.server.serverPrivateKey}`,
    `ListenPort = ${state.server.listenPort}`
  ];

  const peers = activeOnly
    ? state.peers.filter((peer) => isPeerActive(peer))
    : state.peers;

  for (const peer of peers) {
    lines.push("", "[Peer]", `PublicKey = ${peer.publicKey}`);
    if (peer.allowedIps.length > 0) {
      lines.push(`AllowedIPs = ${peer.allowedIps.join(", ")}`);
    }
    if (peer.persistentKeepalive > 0) {
      lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Drive intended state onto the WireGuard runtime. This is the single bridge
 * between declared configuration and host kernel state. The function is the
 * only producer of `apply.*` audit events on the live path. Failures that
 * prevent any host mutation (e.g. capability gaps) throw `ApplyError` so the
 * caller can mark `reconcile.ok=false` without losing the cause; failures
 * observed during execution are accumulated into `result.errors[]` so a
 * partial apply still surfaces its diagnostics.
 */
export async function executeApply(req: ApplyRequest): Promise<ApplyResult> {
  const startedAt = new Date().toISOString();
  const messages: string[] = [];
  const errors: string[] = [];
  const actionsExecuted: string[] = [];

  // Re-validate duplicates against the same active-peers set the runtime
  // module uses. Reconcile already runs this check; we re-run here for
  // callers that invoke executeApply directly (tests, /v1/reconcile dry-run).
  const activePeers = req.state.peers.filter((peer) => isPeerActive(peer));
  const seenPubKeys = new Set<string>();
  const seenAddresses = new Set<string>();
  for (const peer of activePeers) {
    if (seenPubKeys.has(peer.publicKey)) {
      throw new ApplyError(
        "duplicate_pubkey",
        `Duplicate peer public key: ${peer.name}`,
        { public_key: peer.publicKey, peer_name: peer.name }
      );
    }
    if (seenAddresses.has(peer.addressV4)) {
      throw new ApplyError(
        "duplicate_address",
        `Duplicate peer address: ${peer.addressV4}`,
        { address_v4: peer.addressV4, peer_name: peer.name }
      );
    }
    seenPubKeys.add(peer.publicKey);
    seenAddresses.add(peer.addressV4);
  }

  // Dry-run path: plan + render + diff, no host exec, no audit events.
  if (req.dryRun) {
    const runtime = snapshotDryRun(req.state);
    const currentPublicKeys = new Set(runtime.peers.map((peer) => peer.publicKey));
    const diff = await diffPeers(activePeers, currentPublicKeys);
    const plan = planApply(req.state, runtime);
    const ini = renderWgIni(req.state, true);

    messages.push(
      "Dry-run: validated intended state without touching host networking."
    );
    messages.push(
      `Plan: bootstrap=${plan.bootstrap} reconfigure=${plan.reconfigureInterface} add=${diff.add.length} remove=${diff.remove.length}.`
    );
    messages.push(`Rendered ${countLines(ini)} INI lines for ${activePeers.length} active peer(s).`);

    return {
      ok: true,
      dryRun: true,
      bootstrap: plan.bootstrap,
      applied: false,
      revision: req.state.revision,
      interfaceName: req.state.server.interfaceName,
      actionsExecuted: [],
      peerChanges: { added: diff.add, removed: diff.remove, modified: diff.modify },
      startedAt,
      finishedAt: new Date().toISOString(),
      messages,
      errors
    };
  }

  if (!hostNetworkingEnabled()) {
    throw new ApplyError(
      "dry_run_only",
      "executeApply({dryRun:false}) requires KINTUNNEL_ENABLE_HOST_NETWORKING=true",
      { env_var: "KINTUNNEL_ENABLE_HOST_NETWORKING" }
    );
  }

  // Live path: serialize concurrent reconciles through a dedicated flock so
  // backup restore can hold its own lock without deadlocking the apply queue.
  return withFileLock(
    APPLY_LOCK_PATH,
    async () => {
      const config = resolveConfigFromState(req.state);
      const runtime = await getRuntimeState(config, req.state);
      const plan = planApply(req.state, runtime);
      const currentPublicKeys = new Set(runtime.peers.map((peer) => peer.publicKey));
      const diff = await diffPeers(activePeers, currentPublicKeys);
      const peerChanges = {
        added: diff.add,
        removed: diff.remove,
        modified: diff.modify
      };

      // Bootstrap path: bring up the interface from scratch.
      if (plan.bootstrap) {
        await bootstrapInterface(req.state);
        actionsExecuted.push("apply.interface.created");
        emitAudit(req.state, "apply.interface.created", {
          interface: req.state.server.interfaceName,
          listen_port: req.state.server.listenPort,
          public_key: req.state.server.serverPublicKey
        });
      } else if (plan.reconfigureInterface) {
        await reconfigInterface(req.state);
        actionsExecuted.push("apply.interface.reconfigured");
        emitAudit(req.state, "apply.interface.reconfigured", {
          interface: req.state.server.interfaceName,
          fields_changed: "listen_port"
        });
      }

      // Warm peer sync via wg syncconf. The INI contains the [Interface]
      // block plus all currently-active peers; syncconf applies the diff
      // against the existing kernel state without tearing the interface.
      if (activePeers.length > 0 || peerChanges.removed.length > 0) {
        const ini = renderWgIni(req.state, true);
        const iniPath = await writeTempIni(ini);
        try {
          await execWg(["syncconf", req.state.server.interfaceName, iniPath]);
          actionsExecuted.push("apply.peer.synced");
          emitAudit(req.state, "apply.peer.synced", {
            count_added: peerChanges.added.length,
            count_modified: peerChanges.modified.length,
            count_unchanged: activePeers.length - peerChanges.added.length - peerChanges.modified.length
          });
        } catch (error) {
          throw new ApplyError(
            "syncconf_failed",
            `wg syncconf failed: ${(error as Error).message}`,
            { interface: req.state.server.interfaceName }
          );
        } finally {
          await rm(iniPath, { force: true });
        }
      }

      // Peer removals happen via `wg set ... peer ... remove` because syncconf
      // only adjusts existing peers; a peer absent from the INI but present
      // in the runtime must be removed explicitly.
      for (const pubKey of peerChanges.removed) {
        try {
          await removePeer(req.state.server.interfaceName, pubKey);
          actionsExecuted.push("apply.peer.removed");
          emitAudit(req.state, "apply.peer.removed", {
            public_key: pubKey
          });
        } catch (error) {
          if (error instanceof ApplyError) throw error;
          throw new ApplyError(
            "peer_remove_failed",
            `Failed to remove peer ${pubKey}: ${(error as Error).message}`,
            { public_key: pubKey }
          );
        }
      }

      // Emit `apply.peer.added` per newly-present peer so audit consumers can
      // correlate the per-peer sync against the aggregate `apply.peer.synced`.
      for (const pubKey of peerChanges.added) {
        const peer = activePeers.find((candidate) => candidate.publicKey === pubKey);
        if (!peer) continue;
        emitAudit(req.state, "apply.peer.added", {
          public_key: pubKey,
          peer_name: peer.name,
          address_v4: peer.addressV4
        });
        actionsExecuted.push("apply.peer.added");
      }

      // Drift detection. Required fields (listenPort + serverPublicKey) must
      // match after syncconf; mismatches in ListenPort are recoverable via
      // rollback; mismatches in serverPublicKey are not (rotating the
      // private key would require engine restart — out of Phase 1 scope).
      const drift = await detectDrift(req.state);
      if (drift.detected) {
        errors.push(...drift.messages);
        emitAudit(req.state, "apply.drift.detected", {
          fields: drift.fields.join(","),
          expected: JSON.stringify({
            listenPort: req.state.server.listenPort,
            serverPublicKey: req.state.server.serverPublicKey
          }),
          actual: drift.actual
        });
        if (drift.fields.includes("listenPort")) {
          await rollbackPlan(req.state, plan);
          actionsExecuted.push("apply.rollback.executed");
        }
      }

      return {
        ok: errors.length === 0,
        dryRun: false,
        bootstrap: plan.bootstrap,
        applied: errors.length === 0,
        revision: req.state.revision,
        interfaceName: req.state.server.interfaceName,
        actionsExecuted,
        peerChanges,
        drift: { detected: drift.detected, fields: drift.fields },
        startedAt,
        finishedAt: new Date().toISOString(),
        messages,
        errors
      };
    },
    { timeoutMs: APPLY_LOCK_TIMEOUT_MS }
  );
}

/**
 * Reverse the actions described by `lastPlan` in reverse order. Always
 * best-effort — emits `apply.rollback.executed` regardless of intermediate
 * failure so operators have a record of what was attempted.
 */
export async function rollbackPlan(state: EngineState, lastPlan: ApplyPlan): Promise<void> {
  const stepsReversed: string[] = [];

  // Reverse peer removals: any peer we added but the runtime hasn't seen
  // yet (because syncconf failed or drift kicked in) is still in the kernel.
  for (const pubKey of lastPlan.addPeers) {
    try {
      await removePeer(state.server.interfaceName, pubKey);
      stepsReversed.push(`peer.remove:${pubKey}`);
    } catch {
      // best-effort — record and continue
      stepsReversed.push(`peer.remove:failed:${pubKey}`);
    }
  }

  // If we bootstrapped the interface and the rollback happens before any
  // peer sync, the safest thing is to remove the whole link. Once peers
  // are visible to the runtime we leave the link up and rely on per-peer
  // removal above; the operator can `ip link del` manually if needed.
  if (lastPlan.bootstrap && stepsReversed.every((step) => !step.includes("failed"))) {
    try {
      await execIpLink(["del", state.server.interfaceName]);
      stepsReversed.push("interface.del");
    } catch {
      stepsReversed.push("interface.del:failed");
    }
  }

  emitAudit(state, "apply.rollback.executed", {
    reason: "drift_unrecoverable",
    steps_reversed: stepsReversed.join(",")
  });
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function bootstrapInterface(state: EngineState): Promise<void> {
  const iface = state.server.interfaceName;
  const ini = [
    "[Interface]",
    `PrivateKey = ${state.server.serverPrivateKey}`,
    `ListenPort = ${state.server.listenPort}`,
    ""
  ].join("\n");
  const iniPath = await writeTempIni(ini);

  try {
    await execIpLink(["add", iface, "type", "wireguard"]);
    try {
      await execWg(["setconf", iface, iniPath]);
      await execIpAddr(["replace", state.server.serverAddressV4, "dev", iface]);
      const mtu = state.server.mtu ?? DEFAULT_MTU;
      await execIpLink(["set", "dev", iface, "mtu", String(mtu), "up"]);
    } catch (error) {
      // Best-effort rollback: if any step between `ip link add` and the
      // final `up` fails, remove the half-configured interface so a
      // subsequent reconcile can re-attempt from a clean slate.
      await execIpLink(["del", iface]).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(iniPath, { force: true });
  }
}

async function reconfigInterface(state: EngineState): Promise<void> {
  // Re-render the INI and run syncconf with the new ListenPort/PrivateKey.
  // syncconf handles [Interface] block changes atomically without dropping
  // the link, so existing peer sessions survive a port rotation.
  const ini = renderWgIni(state, true);
  const iniPath = await writeTempIni(ini);
  try {
    await execWg(["syncconf", state.server.interfaceName, iniPath]);
  } finally {
    await rm(iniPath, { force: true });
  }
}

async function removePeer(iface: string, publicKey: string): Promise<void> {
  try {
    await execWg(["set", iface, "peer", publicKey, "remove"]);
    return;
  } catch (error) {
    // One retry — `wg set ... remove` can race with a peer handshake close
    // and transiently fail with EBUSY on busy kernels.
  }
  await execWg(["set", iface, "peer", publicKey, "remove"]);
}

async function detectDrift(
  state: EngineState
): Promise<{ detected: boolean; fields: string[]; messages: string[]; actual: string }> {
  const fields: string[] = [];
  const messages: string[] = [];
  let actual = "{}";

  try {
    const { stdout } = await execWg(["show", state.server.interfaceName, "dump"]);
    const [interfaceRow] = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!interfaceRow) {
      return {
        detected: true,
        fields: ["interface_row_missing"],
        messages: ["Drift detection failed: wg show dump returned no interface row"],
        actual: "<empty>"
      };
    }
    const [, publicKeyRaw, listenPortRaw] = interfaceRow.split("\t");
    const listenPort = Number.parseInt(listenPortRaw ?? "", 10);
    actual = JSON.stringify({ listenPort, publicKey: publicKeyRaw ?? "" });

    if (Number.isInteger(listenPort) && listenPort !== state.server.listenPort) {
      fields.push("listenPort");
      messages.push(
        `Drift detected: listenPort ${listenPort} != ${state.server.listenPort}`
      );
    }
    if (publicKeyRaw && publicKeyRaw !== state.server.serverPublicKey) {
      fields.push("serverPublicKey");
      messages.push(
        `Drift detected: serverPublicKey ${publicKeyRaw} != ${state.server.serverPublicKey}`
      );
    }
  } catch (error) {
    return {
      detected: true,
      fields: ["dump_unavailable"],
      messages: [`Drift detection failed: ${(error as Error).message}`],
      actual: "<unavailable>"
    };
  }

  return { detected: fields.length > 0, fields, messages, actual };
}

async function execWg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execHost("wg", args);
}

async function execIpLink(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execHost("ip", ["-|link", ...args]);
}

async function execIpAddr(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execHost("ip", ["-|addr", ...args]);
}

async function execHost(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(cmd, args, {
      windowsHide: true,
      timeout: EXEC_TIMEOUT_MS
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new Error(
      `${cmd} ${args.join(" ")} failed (code=${(err as { code?: number }).code ?? "?"}): ${
        err.stderr?.trim() || err.message
      }`
    );
  }
}

async function writeTempIni(content: string): Promise<string> {
  await mkdir(TEMP_INI_DIR, { recursive: true });
  const filename = `wg-${process.pid}-${randomBytes(8).toString("hex")}.ini`;
  const filePath = path.join(TEMP_INI_DIR, filename);
  await writeFile(filePath, content, { mode: TEMP_INI_MODE });
  return filePath;
}

function snapshotDryRun(state: EngineState): RuntimeState {
  // Mirror the dry-run branch in runtime.getRuntimeState so planApply sees a
  // shape consistent with what the live path will see on first call. We
  // assume the interface "exists" in dry-run (matches runtime.getRuntimeState's
  // dry-run behaviour); the dry-run diagnostic then reflects the diff between
  // intended and current intended, which is the no-op baseline.
  return {
    interfaceName: state.server.interfaceName,
    exists: true,
    listenPort: state.server.listenPort,
    peers: state.peers
      .filter((peer) => isPeerActive(peer))
      .map((peer: PeerRecord) => ({
        publicKey: peer.publicKey,
        allowedIps: [peer.addressV4]
      })),
    rawAvailable: false
  };
}

function resolveConfigFromState(state: EngineState): EngineConfig {
  // executeApply receives only `state`, so we synthesise a minimal EngineConfig
  // shape that satisfies getRuntimeState's read-only fields. We intentionally
  // do NOT pass an apiToken or write paths; getRuntimeState never touches them
  // for the read-only wg show call.
  return {
    env: "production",
    port: 0,
    dataDir: "/var/lib/kintunnel",
    statePath: "/var/lib/kintunnel/state.json",
    dryRun: false,
    apiToken: "unused",
    interfaceName: state.server.interfaceName,
    listenPort: state.server.listenPort,
    endpointHost: state.server.endpointHost,
    endpointPort: state.server.endpointPort,
    tunnelCidrV4: state.server.tunnelCidrV4,
    defaultAllowedIps: state.server.defaultAllowedIps,
    defaultDnsServers: state.server.defaultDnsServers,
    persistentKeepalive: state.server.persistentKeepalive,
    natEnabled: state.server.natEnabled,
    forwardingRequired: state.server.forwardingRequired,
    natApply: false,
    backupDir: "/backups",
    backupRetentionCount: 10,
    backupLockTimeoutMs: 30_000,
    applyBootstrapTimeoutMs: 15_000
  };
}

function hostNetworkingEnabled(): boolean {
  const raw = process.env.KINTUNNEL_ENABLE_HOST_NETWORKING;
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length - 1;
}

function emitAudit(
  state: EngineState,
  action: AuditAction,
  metadata: Record<string, string | number | boolean | null>
): void {
  // Mirror StateStore.appendEvent's mutation semantics without instantiating a
  // throwaway StateStore (state.ts's constructor requires a full EngineConfig;
  // we don't have one in apply.ts's hot path). The shape is identical to what
  // StateStore.appendEvent produces, so consumers reading state.events see
  // events in the same order/format whether they were emitted here or via the
  // StateStore. The audit log cap (MAX_AUDIT_EVENTS = 250) is preserved.
  const record = {
    id: randomUUID(),
    action,
    actor: "engine" as const,
    revision: state.revision,
    createdAt: new Date().toISOString(),
    metadata
  };
  state.events = [...(state.events ?? []), record].slice(-250);
}
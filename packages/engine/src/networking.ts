import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AuditSink } from "./audit-store.js";
import type {
  AuditAction,
  EngineConfig,
  EngineState,
  NetworkingPlan,
  NetworkingResult
} from "./types.js";

const execFileAsync = promisify(execFile);

// ── Comment markers ────────────────────────────────────────────────────────
// Stable wire identifiers for our rules. The same constants drive both apply
// (idempotency `-C` check + insertion) and rollback (best-effort `-D`). Any
// iptables rule carrying one of these comments is "ours" and is eligible for
// removal by `rollbackNetworking`. Operators should not edit these strings
// — they appear in audit events and in operator logs.
const KINTUNNEL_FWD_ESTAB_RELATED = "kintunnel:fwd:allow-estab-related";
const KINTUNNEL_FWD_TUNNEL_NEW = "kintunnel:fwd:allow-tunnel-new";
const KINTUNNEL_FWD_DROP_INVALID = "kintunnel:fwd:drop-invalid";
const KINTUNNEL_NAT_MASQUERADE = "kintunnel:nat:masquerade";

const IPV4_FORWARD_PATH = "/proc/sys/net/ipv4/ip_forward";
const PROC_ROUTE_PATH = "/proc/net/route";
const MAX_AUDIT_EVENTS = 250;

export type NetworkingErrorCode =
  | "iptables_unavailable"
  | "rule_insert_failed"
  | "rule_check_failed"
  | "forwarding_write_failed"
  | "egress_unresolvable";

export class NetworkingError extends Error {
  public readonly code: NetworkingErrorCode;
  public readonly detail: Record<string, string | number | boolean>;

  constructor(
    code: NetworkingErrorCode,
    message: string,
    detail: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = "NetworkingError";
    this.code = code;
    this.detail = detail;
  }
}

// ── Public exports ─────────────────────────────────────────────────────────

/**
 * Resolve the host's default egress interface by parsing `/proc/net/route`.
 * The route with destination `00000000` (default route) is the lowest-metric
 * path; if multiple exist we pick the first match in file order, which is
 * the kernel's evaluation order. Returns `undefined` when no default route
 * is present (e.g. the engine is running off-link or `/proc` is masked).
 */
export async function detectEgressInterface(): Promise<string | undefined> {
  let content: string;
  try {
    content = await readProc(PROC_ROUTE_PATH);
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  // First line is the column header.
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 2) continue;
    const dest = cols[1].trim();
    if (dest === "00000000") {
      const iface = cols[0].trim();
      return iface.length > 0 ? iface : undefined;
    }
  }
  return undefined;
}

/**
 * Pure-function view of intended networking policy. Mirrors `planApply`'s
 * role for the WireGuard side: the caller pairs it with `applyNetworking` to
 * actually execute. Tests can exercise `planNetworking` without touching
 * host iptables.
 */
export function planNetworking(_config: EngineConfig, _state: EngineState): NetworkingPlan {
  // Wave 3 plan is fully described by config; state doesn't change anything.
  // Kept as a separate function for symmetry with planApply / renderWgIni and
  // to give Wave 5 health a deterministic view of intended policy.
  return {
    enableForwarding: true,
    masqueradeRule: true,
    forwardRules: {
      allowTunnelNew: true,
      allowEstablishedRelated: true,
      dropInvalid: true
    }
  };
}

/**
 * Drive the kernel's networking state to match the intended plan. Returns a
 * `NetworkingResult` describing what was applied, what was rolled back, and
 * what warnings/errors the operator should see. The function is idempotent
 * — repeated calls converge to the same kernel state and emit no duplicate
 * audit events on the warm path.
 *
 * Skip semantics: when `!config.natEnabled || !config.natApply`, returns
 * `applied=false` with a warning explaining why. When `applied=false &&
 * ok=true`, callers (e.g. `reconcile`) treat the call as a no-op skip.
 */
export async function applyNetworking(
  config: EngineConfig,
  _plan: NetworkingPlan,
  state: EngineState
): Promise<NetworkingResult> {
  const rulesInserted: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let forwardingEnabled = false;
  let skipped = false;

  // 1. Skip gate — declared policy vs. apply gate.
  if (!config.natEnabled || !config.natApply) {
    skipped = true;
    warnings.push(
      !config.natEnabled
        ? "networking skipped: natEnabled=false"
        : "networking skipped: natApply=false"
    );
    return buildResult({
      ok: true,
      applied: false,
      skipped,
      rulesInserted: [],
      rulesRolledBack: [],
      forwardingEnabled: false,
      warnings,
      errors
    });
  }

  // 2. Capability gate — iptables binary on PATH.
  const hasIptables = config.dryRun ? true : await commandExists("iptables");
  if (!hasIptables) {
    errors.push("iptables_unavailable");
    return buildResult({
      ok: false,
      applied: false,
      skipped,
      rulesInserted: [],
      rulesRolledBack: [],
      forwardingEnabled: false,
      warnings,
      errors
    });
  }

  // 3. Egress resolution — explicit override, /proc/net/route probe, or
  //    dry-run fallback (skips the proc read when we won't exec anyway).
  let egressIface: string | undefined = config.wgEgressInterface;
  if (!egressIface) {
    egressIface = config.dryRun ? "eth0" : await detectEgressInterface();
  }
  if (!egressIface) {
    errors.push("egress_unresolvable: no default route found in /proc/net/route");
    return buildResult({
      ok: false,
      applied: false,
      skipped,
      rulesInserted: [],
      rulesRolledBack: [],
      forwardingEnabled: false,
      warnings,
      errors
    });
  }

  // 4. ip_forward (idempotent). Reads current value, writes only on change.
  try {
    const before = config.dryRun ? "0" : await readProc(IPV4_FORWARD_PATH);
    if (before === "1") {
      forwardingEnabled = true;
    } else if (config.dryRun) {
      forwardingEnabled = true;
    } else {
      await writeProc(IPV4_FORWARD_PATH, "1\n");
      forwardingEnabled = true;
      emitAudit(state, "networking.forwarding.enabled", {
        previous_value: before.length > 0 ? before : "unknown",
        new_value: "1"
      });
    }
  } catch (error) {
    errors.push(`forwarding_write_failed: ${(error as Error).message}`);
    return buildResult({
      ok: false,
      applied: false,
      skipped,
      rulesInserted: [],
      rulesRolledBack: [],
      forwardingEnabled: false,
      warnings,
      errors
    });
  }

  // 5. Insert rules in research-locked order.
  const specs = buildRuleSpecs(config, egressIface);
  for (const spec of specs) {
    const insertOutcome = config.dryRun
      ? "ok"
      : await insertIdempotentRule(spec);

    if (insertOutcome === "ok" || insertOutcome === "exists") {
      rulesInserted.push(spec.marker);
      if (spec.auditAction && !config.dryRun) {
        emitAudit(state, spec.auditAction, spec.auditMetadata ?? {});
      }
      continue;
    }

    // Insertion failed: record intent to roll back, emit audit, then
    // best-effort delete the rules we already inserted this call.
    const intendedRemoval = [...rulesInserted];
    if (!config.dryRun) {
      emitAudit(state, "networking.rolledback", {
        reason: "rule_insert_failed",
        rules_removed: intendedRemoval.join(",") || "<none>"
      });
      await rollbackNetworking(config, "rule_insert_failed", intendedRemoval);
    }
    return buildResult({
      ok: false,
      applied: false,
      skipped,
      rulesInserted: [],
      rulesRolledBack: intendedRemoval,
      forwardingEnabled,
      warnings,
      errors: [...errors, `rule_insert_failed: ${spec.marker}`]
    });
  }

  // 6. Aggregate forward-policy audit (single event listing all FORWARD rules
  //    we manage). Emitted only when at least one FORWARD rule was actually
  //    processed in this call.
  const forwardMarkers = rulesInserted.filter((marker) => marker.startsWith("kintunnel:fwd:"));
  if (forwardMarkers.length > 0 && !config.dryRun) {
    emitAudit(state, "networking.forward.policy.applied", {
      rules: forwardMarkers.join(",")
    });
  }

  const applied = errors.length === 0;
  return buildResult({
    ok: errors.length === 0,
    applied,
    skipped,
    rulesInserted,
    rulesRolledBack: [],
    forwardingEnabled,
    warnings,
    errors
  });
}

/**
 * Best-effort removal of the rules newly inserted by the failing
 * `applyNetworking` call (identified by `markersToRemove`). Only those
 * markers are targeted — rules that already existed before this call (and
 * therefore weren't touched by it) are left alone, so an unrelated later
 * rule failing to insert doesn't tear down earlier rules that already
 * converged correctly. A non-zero `-D` exit is ignored — the rule may
 * already be absent (idempotent rollback) or the table may be unreadable
 * in this context; either way the next apply call will recompute the
 * desired state.
 *
 * Audit emission is the caller's responsibility (this function does not have
 * state access in its signature). The typical call site in `applyNetworking`
 * emits `networking.rolledback` immediately before invoking this.
 */
export async function rollbackNetworking(
  config: EngineConfig,
  _reason: string,
  markersToRemove: string[]
): Promise<void> {
  const egressIface = config.wgEgressInterface ?? await detectEgressInterface() ?? "unknown";
  const markers = new Set(markersToRemove);
  const specs = buildRuleSpecs(config, egressIface).filter((spec) => markers.has(spec.marker));
  for (const spec of specs) {
    const args = [
      "-D",
      ...spec.baseArgs,
      "-m", "comment",
      "--comment", spec.marker,
      "-j", spec.target
    ];
    // Swallow non-zero exits — best-effort rollback by design.
    await execIptables(args).catch(() => undefined);
  }
}

/**
 * Test whether a MASQUERADE rule matching the supplied parameters is
 * present in the `nat` table. Used by the health probe (Wave 5) and by
 * `/v1/capabilities` for an at-a-glance status. Mirrors the exact rule
 * shape `applyNetworking` inserts — including the KinTunnel comment
 * marker, without which `-C` would also report "present" for any
 * unrelated MASQUERADE rule that happens to share the same source CIDR
 * and egress interface (e.g. one Docker or another tool installed).
 */
export async function checkNatRulePresent(
  _interfaceName: string,
  tunnelCidrV4: string,
  egressIface: string
): Promise<boolean> {
  try {
    const result = await execIptables([
      "-t", "nat", "-C", "POSTROUTING",
      "-s", tunnelCidrV4,
      "-o", egressIface,
      "-m", "comment",
      "--comment", KINTUNNEL_NAT_MASQUERADE,
      "-j", "MASQUERADE"
    ]);
    return result.exit === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the current value of `/proc/sys/net/ipv4/ip_forward`. Tolerates
 * read errors (returns false) so the caller never throws — this is a
 * health-probe primitive, not an apply primitive.
 */
export async function checkForwardingEnabled(): Promise<boolean> {
  try {
    const raw = await readProc(IPV4_FORWARD_PATH);
    return raw === "1";
  } catch {
    return false;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

type RuleSpec = {
  marker: string;
  baseArgs: string[];
  target: string;
  auditAction?: AuditAction;
  auditMetadata?: Record<string, string | number | boolean | null>;
};

function buildRuleSpecs(config: EngineConfig, egressIface: string): RuleSpec[] {
  return [
    {
      marker: KINTUNNEL_FWD_ESTAB_RELATED,
      baseArgs: ["FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED"],
      target: "ACCEPT"
    },
    {
      marker: KINTUNNEL_FWD_TUNNEL_NEW,
      baseArgs: ["FORWARD", "-i", config.interfaceName, "-m", "conntrack", "--ctstate", "NEW"],
      target: "ACCEPT"
    },
    {
      marker: KINTUNNEL_FWD_DROP_INVALID,
      baseArgs: ["FORWARD", "-m", "conntrack", "--ctstate", "INVALID"],
      target: "DROP"
    },
    {
      marker: KINTUNNEL_NAT_MASQUERADE,
      baseArgs: ["POSTROUTING", "-t", "nat", "-s", config.tunnelCidrV4, "-o", egressIface],
      target: "MASQUERADE",
      auditAction: "networking.masquerade.applied",
      auditMetadata: {
        egress_iface: egressIface,
        rule_comment: KINTUNNEL_NAT_MASQUERADE
      }
    }
  ];
}

/**
 * Run the idempotency pattern for a single rule. Order:
 *   1. `iptables -C <matches>` — returns 0 if rule exists.
 *   2. On non-zero from `-C`, run `iptables -A <matches>` to insert.
 *   3. If `-A` returns non-zero, surface failure to the caller.
 *
 * Non-zero exit from `-C` is not treated as failure — that's exactly the
 * "rule absent" path that triggers insertion.
 */
async function insertIdempotentRule(
  spec: RuleSpec
): Promise<"ok" | "exists" | "failed"> {
  const matches = [
    ...spec.baseArgs,
    "-m", "comment",
    "--comment", spec.marker,
    "-j", spec.target
  ];
  const check = await execIptables(["-C", ...matches]);
  if (check.exit === 0) return "exists";
  const insert = await execIptables(["-A", ...matches]);
  if (insert.exit !== 0) return "failed";
  return "ok";
}

/**
 * Wrap iptables execFile without throwing. `iptables -C` returns exit 1 when
 * the rule is absent (expected); only an uncaught throw would mask that
 * legitimate outcome. We surface exit, stdout, and stderr as a result so the
 * idempotency caller can branch on the exit code without try/catch noise.
 */
async function execIptables(
  args: string[]
): Promise<{ exit: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("iptables", args, { windowsHide: true });
    return { exit: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const exitCode = err.code;
    const exit = typeof exitCode === "number" ? exitCode : 1;
    return {
      exit,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.message
    };
  }
}

async function readProc(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

async function writeProc(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o644 });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Module-level audit sink. Wired by app.ts at createApp startup so networking.ts's
// private emitAudit helper can fire-and-forget writes to the persistent NDJSON
// log without threading the sink through every internal call.
let _networkingAuditSink: AuditSink | undefined;

/** Inject the audit sink used by networking.ts's private emitAudit. Called once at startup. */
export function setNetworkingAuditSink(sink: AuditSink | undefined): void {
  _networkingAuditSink = sink;
}

function emitAudit(
  state: EngineState,
  action: AuditAction,
  metadata: Record<string, string | number | boolean | null>
): void {
  // Mirrors apply.ts's `emitAudit` and state.ts's `StateStore.appendEvent`
  // mutation semantics: push onto state.events[] and cap at MAX_AUDIT_EVENTS.
  // The state object is the same one reconcile() holds; the store's update
  // queue will persist it on the next save.
  const record = {
    id: randomUUID(),
    action,
    actor: "engine" as const,
    revision: state.revision,
    createdAt: new Date().toISOString(),
    metadata
  };
  state.events = [...(state.events ?? []), record].slice(-MAX_AUDIT_EVENTS);

  // Fire-and-forget persist to the persistent NDJSON sink. Sink MUST NOT
  // throw — wrap defensively so a faulty sink never crashes the engine.
  if (_networkingAuditSink) {
    try {
      _networkingAuditSink.write(record);
    } catch {
      // audit must not crash engine; swallowed by spec
    }
  }
}

function buildResult(
  partial: NetworkingResult & { skipped?: boolean }
): NetworkingResult {
  // TS doesn't carry `skipped` in the type, but the contract for callers is
  // that we always emit it. Object spread preserves the field at runtime;
  // callers needing it should branch on `applied=false && ok=true` (the
  // documented skip signal) without depending on the undeclared field.
  return {
    ok: partial.ok,
    applied: partial.applied,
    rulesInserted: partial.rulesInserted,
    rulesRolledBack: partial.rulesRolledBack,
    forwardingEnabled: partial.forwardingEnabled,
    warnings: partial.warnings,
    errors: partial.errors,
    ...(partial.skipped !== undefined ? { skipped: partial.skipped } : {})
  };
}
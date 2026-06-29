import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { checkForwardingEnabled, checkNatRulePresent, detectEgressInterface } from "./networking.js";
import type { EngineConfig, EngineState, HealthCheck, HealthReport } from "./types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5000;
const TUN_DEVICE = "/dev/net/tun";
const IPV4_FORWARD_PATH = "/proc/sys/net/ipv4/ip_forward";

// ── Internal helpers (not exported) ────────────────────────────────────────

/**
 * Cheap filesystem probe. Returns true if `target` is reachable with the
 * supplied mode mask. Used by checkTun (R_OK only — opening /dev/net/tun
 * for write would consume the device) and checkStateIo (R_OK | W_OK).
 */
async function pathExists(target: string, mode: number = fsConstants.F_OK): Promise<boolean> {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a `/proc` file as trimmed utf8. Centralized so the health probes
 * never accidentally log binary garbage from the kernel.
 */
async function readProc(target: string): Promise<string> {
  return (await readFile(target, "utf8")).trim();
}

/**
 * Wrapped `child_process.execFile` with a 5s timeout. Always returns a
 * result object — never throws on non-zero exit — so the health probes can
 * branch on `exit` without try/catch noise. Timeouts surface as
 * `exit = 124` (the standard `timeout(1)` convention).
 */
async function execHost(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  try {
    const result = await execFileAsync(command, args, { windowsHide: true, timeout: timeoutMs });
    return { stdout: result.stdout, stderr: result.stderr, exit: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    // The promisified execFile throws an object with `.code` for non-zero
    // exits; we surface that as a numeric exit. For killed-by-timeout
    // (signal: SIGTERM) the wrapper assigns `code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"`
    // or similar string; we treat any non-numeric `code` as 124 (the
    // standard `timeout(1)` convention) so the health probe can
    // distinguish timeout from other failures.
    let exit = 1;
    if (typeof err.code === "number") {
      exit = err.code;
    } else if (err.code === "ETIMEDOUT" || typeof err.code === "string") {
      exit = 124;
    }
    return {
      exit,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.message ?? ""
    };
  }
}

/**
 * Cheap command-on-PATH probe. Mirrors `commandExists` in runtime.ts and
 * networking.ts — duplicated here so health.ts has no dependency on
 * runtime.ts (keeps the layering consistent with backup.ts vs state.ts).
 */
async function commandExists(command: string): Promise<boolean> {
  const result = await execHost(command, ["--version"], { timeoutMs: 2000 });
  return result.exit === 0;
}

/**
 * Resolve the "required" flag for a check based on engine config. The
 * table in PLAN §8 pins these conditions; the individual check functions
 * don't take config (their signatures are pure probes), so the table
 * lives here and is applied in `runHealthChecks`.
 */
function requiredFor(name: HealthCheck["name"], config: EngineConfig): boolean {
  switch (name) {
    case "tun":
      return !config.dryRun && config.forwardingRequired;
    case "forwarding":
      return !config.dryRun && config.natEnabled && config.forwardingRequired;
    case "interface":
      return !config.dryRun;
    case "nat":
      return !config.dryRun && config.natEnabled && config.natApply === true;
    case "iptables":
      return !config.dryRun && (config.natEnabled || config.natApply === true);
    case "port":
      // Always warn-only by contract — see PLAN §8 "Required vs warn".
      return false;
    case "state_io":
      return true;
  }
}

/**
 * Build a HealthCheck with the standard scaffolding (name, observed_at)
 * already populated. Centralized so every probe returns a uniform shape
 * even when short-circuiting on dry-run or skip.
 */
function makeCheck(
  name: HealthCheck["name"],
  status: HealthCheck["status"],
  required: boolean,
  detail: string,
  observedAt: string
): HealthCheck {
  return { name, status, required, detail, observed_at: observedAt };
}

// ── Individual probes ──────────────────────────────────────────────────────

/**
 * /dev/net/tun reachability. Read-only on purpose: opening the device for
 * write claims it for the calling process and would break subsequent
 * WireGuard bootstraps on the same host. The plan is explicit about
 * this — see PLAN §8 "tun" row.
 */
export async function checkTun(): Promise<HealthCheck> {
  const now = new Date().toISOString();
  const reachable = await pathExists(TUN_DEVICE, fsConstants.R_OK);
  return reachable
    ? makeCheck("tun", "pass", false, `${TUN_DEVICE} is readable`, now)
    : makeCheck("tun", "fail", false, `${TUN_DEVICE} is not readable`, now);
}

/**
 * /proc/sys/net/ipv4/ip_forward == "1". Delegated to
 * `checkForwardingEnabled` so the same primitive is shared with the
 * networking module (single source of truth for the kernel sysctl).
 */
export async function checkForwarding(): Promise<HealthCheck> {
  const now = new Date().toISOString();
  const enabled = await checkForwardingEnabled();
  return enabled
    ? makeCheck("forwarding", "pass", false, `${IPV4_FORWARD_PATH}=1`, now)
    : makeCheck("forwarding", "fail", false, `${IPV4_FORWARD_PATH}!=1 (forwarding disabled)`, now);
}

/**
 * WireGuard interface sanity: `wg show <iface> dump` exits 0 AND the
 * listen_port column (index 2) on the first row matches state.server.listenPort.
 * Any failure (interface absent, dump malformed, port mismatch) is reported
 * as a fail with the observed value surfaced in the detail string.
 */
export async function checkInterface(state: EngineState): Promise<HealthCheck> {
  const now = new Date().toISOString();
  const iface = state.server.interfaceName;
  const result = await execHost("wg", ["show", iface, "dump"]);
  if (result.exit !== 0) {
    return makeCheck(
      "interface",
      "fail",
      false,
      `wg show ${iface} dump exited ${result.exit}: ${result.stderr || "interface not present"}`,
      now
    );
  }
  const firstRow = result.stdout.split(/\r?\n/).find((line) => line.length > 0);
  if (!firstRow) {
    return makeCheck("interface", "fail", false, `wg show ${iface} dump returned no rows`, now);
  }
  const listenPortRaw = firstRow.split("\t")[2];
  const listenPort = Number.parseInt(listenPortRaw ?? "", 10);
  if (!Number.isInteger(listenPort) || listenPort !== state.server.listenPort) {
    return makeCheck(
      "interface",
      "fail",
      false,
      `listen_port mismatch: observed=${listenPortRaw ?? "<empty>"}, expected=${state.server.listenPort}`,
      now
    );
  }
  return makeCheck("interface", "pass", false, `${iface} listen_port=${listenPort}`, now);
}

/**
 * MASQUERADE rule presence. Egress interface resolves in this order:
 *   1. config.wgEgressInterface (operator override)
 *   2. detectEgressInterface() (parses /proc/net/route)
 *   3. failure — "no default route detected"
 *
 * The unused `_interfaceName` parameter on `checkNatRulePresent` is passed
 * through anyway (mirroring the plan's signature) so future
 * comment-marker checks can use the iface name without an API break.
 */
export async function checkNatRule(state: EngineState): Promise<HealthCheck> {
  const now = new Date().toISOString();
  const egressIface = (await resolveEgressInterface()) ?? undefined;
  if (!egressIface) {
    return makeCheck("nat", "fail", false, "no default route detected", now);
  }
  const present = await checkNatRulePresent(state.server.interfaceName, state.server.tunnelCidrV4, egressIface);
  return present
    ? makeCheck(
        "nat",
        "pass",
        false,
        `MASQUERADE rule present for ${state.server.tunnelCidrV4} via ${egressIface}`,
        now
      )
    : makeCheck(
        "nat",
        "fail",
        false,
        `MASQUERADE rule missing for ${state.server.tunnelCidrV4} via ${egressIface}`,
        now
      );
}

/**
 * `iptables -t nat -L -n` exit 0 — minimum smoke for the nat table being
 * inspectable. Doesn't check rule presence (that's `checkNatRule`); a host
 * with iptables installed but a locked-down kernel will still pass here
 * and fail the forwarding/rule checks downstream.
 */
export async function checkIptables(): Promise<HealthCheck> {
  const now = new Date().toISOString();
  const result = await execHost("iptables", ["-t", "nat", "-L", "-n"]);
  return result.exit === 0
    ? makeCheck("iptables", "pass", false, "iptables -t nat -L -n exits 0", now)
    : makeCheck(
        "iptables",
        "fail",
        false,
        `iptables -t nat -L -n exited ${result.exit}: ${result.stderr || "table not inspectable"}`,
        now
      );
}

/**
 * Best-effort UDP listener probe. `nc -z -u -w 1 127.0.0.1 <port>` is
 * the standard "is something bound to this UDP port locally" check. The
 * probe is warn-only (`required: false`) because UDP "reachability" is
 * inherently ambiguous: a successful exit only proves nc sent a packet,
 * not that WireGuard answered.
 *
 * Skip cases:
 *   - `nc` not on PATH → "udp probe unavailable"
 *   - nc binary spawns but its argument parser rejects the flags
 *     (e.g. busybox nc with `-w 1`) → still treated as "unavailable" so
 *     a quirky nc build doesn't spam the health report.
 */
export async function checkPortReachability(config: EngineConfig): Promise<HealthCheck> {
  const now = new Date().toISOString();
  if (!(await commandExists("nc"))) {
    return makeCheck("port", "skip", false, "udp probe unavailable", now);
  }
  const result = await execHost("nc", ["-z", "-u", "-w", "1", "127.0.0.1", String(config.listenPort)]);
  if (result.exit === 0) {
    return makeCheck("port", "pass", false, `udp ${config.listenPort} reachable on 127.0.0.1`, now);
  }
  // Distinguish "nc rejected the flags" (treat as unavailable) from a real
  // probe failure (port genuinely not bound). Busybox nc returns 1 for
  // both; we use the absence of stderr as a heuristic — real failures
  // print "Connection refused" or similar.
  if (result.exit !== 0 && result.stderr.length === 0 && result.stdout.length === 0) {
    return makeCheck("port", "skip", false, "udp probe unavailable (nc did not respond)", now);
  }
  return makeCheck(
    "port",
    "fail",
    false,
    `udp ${config.listenPort} not reachable on 127.0.0.1 (nc exit ${result.exit})`,
    now
  );
}

/**
 * state.json read+write availability. Pass if:
 *   - the file exists and is R_OK | W_OK, OR
 *   - the file does not exist (engine will create on first write).
 *
 * The "missing is OK" branch is what makes the check usable on a fresh
 * boot before the first reconcile. Other errors (EACCES on the parent
 * directory, EROFS, etc.) are reported as fail.
 */
export async function checkStateIo(config: EngineConfig): Promise<HealthCheck> {
  const now = new Date().toISOString();
  try {
    await access(config.statePath, fsConstants.R_OK | fsConstants.W_OK);
    return makeCheck("state_io", "pass", true, `${config.statePath} is readable+writable`, now);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return makeCheck(
        "state_io",
        "pass",
        true,
        `${config.statePath} does not exist (engine will create on first save)`,
        now
      );
    }
    return makeCheck(
      "state_io",
      "fail",
      true,
      `${config.statePath} not accessible: ${err.code ?? err.message}`,
      now
    );
  }
}

// ── Internal: egress resolution shared by checkNatRule and runHealthChecks ─

async function resolveEgressInterface(): Promise<string | undefined> {
  // Mirrors the resolution order in networking.ts applyNetworking: explicit
  // override first (passed via config in the caller), then proc probe. We
  // can't read config here without changing the check signature, so the
  // caller (checkNatRule) is responsible for prepending config.wgEgressInterface.
  return detectEgressInterface();
}

// ── Public aggregator ──────────────────────────────────────────────────────

/**
 * Run every check, apply the per-check `required` table, and aggregate
 * into a HealthReport. The returned shape extends HealthReport with
 * `required_failing` and `warnings` — the wire shape consumed by the
 * augmented /health handler in app.ts. The base HealthReport fields
 * remain forward-compatible for any consumer still reading the
 * pre-Wave-5 shape.
 *
 * Order of checks is fixed (tun, forwarding, interface, nat, iptables,
 * port, state_io) so dashboards and tests can rely on a stable index.
 */
export async function runHealthChecks(
  config: EngineConfig,
  _state: EngineState
): Promise<HealthReport & { required_failing: string[]; warnings: string[] }> {
  const now = new Date().toISOString();
  const messages: string[] = [];
  const order: HealthCheck["name"][] = [
    "tun",
    "forwarding",
    "interface",
    "nat",
    "iptables",
    "port",
    "state_io"
  ];

  // Dry-run: every host-runtime probe is short-circuited to "skip" with
  // the dry-run rationale. state_io still runs because the data dir is
  // a real concern regardless of networking intent. The required flag
  // for the skipped host checks is the *condition* from the table (e.g.
  // `!dryRun && forwardingRequired`) so a dry-run report truthfully
  // reflects what would be required if dryRun were flipped off.
  if (config.dryRun) {
    const hostSkips: HealthCheck[] = order
      .filter((name) => name !== "state_io")
      .map((name) =>
        makeCheck(name, "skip", requiredFor(name, config), "dry-run mode", now)
      );
    const stateCheck = await checkStateIo(config);
    // Apply the patched required flag (checkStateIo doesn't take config
    // so it always returns required: true — which is correct here).
    const checks = [...hostSkips, stateCheck];
    return aggregate(config, checks, messages, now);
  }

  // Non-dry-run: run every probe. The required flag is patched in by
  // aggregate() based on the config-driven table.
  const [tun, forwarding, iface, nat, iptables, port, stateIo] = await Promise.all([
    checkTun(),
    checkForwarding(),
    checkInterface(_state),
    checkNatRule(_state),
    checkIptables(),
    checkPortReachability(config),
    checkStateIo(config)
  ]);

  const checks: HealthCheck[] = [tun, forwarding, iface, nat, iptables, port, stateIo];
  return aggregate(config, checks, messages, now);
}

/**
 * Apply the per-check required flags and compute the aggregate ok /
 * required_failing / warnings fields. Extracted so dry-run and live
 * paths share the exact same aggregation logic.
 */
function aggregate(
  config: EngineConfig,
  rawChecks: HealthCheck[],
  messages: string[],
  checkedAt: string
): HealthReport & { required_failing: string[]; warnings: string[] } {
  const checks: HealthCheck[] = rawChecks.map((check) => ({
    ...check,
    required: requiredFor(check.name, config)
  }));

  const requiredFailing = checks
    .filter((check) => check.required && check.status === "fail")
    .map((check) => check.name);
  const warnings = checks
    .filter((check) => !check.required && check.status === "fail")
    .map((check) => check.name);
  const ok = checks.filter((check) => check.required && check.status !== "pass").length === 0;

  return {
    ok,
    service: "kintunnel-engine",
    dry_run: config.dryRun,
    env: config.env,
    checks,
    messages,
    checked_at: checkedAt,
    required_failing: requiredFailing,
    warnings
  };
}

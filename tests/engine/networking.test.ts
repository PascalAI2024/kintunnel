import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock node:child_process ────────────────────────────────────────────────
// See apply.test.ts for the rationale on the custom promisify symbol
// mirroring — networking.ts's `execIptables` and `commandExists` helpers
// both rely on `execFile` resolving to `{stdout, stderr}` after promisify.
const execState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  responder: (_call: { command: string; args: string[] }) =>
    ({ stdout: "", stderr: "", exit: 0 }) as { stdout?: string; stderr?: string; exit?: number; error?: Error }
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const realExecFile = actual.execFile;
  const realSymbols = Object.getOwnPropertySymbols(realExecFile);

  const mockExecFile = (
    command: string,
    args: string[] | Buffer[] | readonly string[] | readonly Buffer[],
    _optionsOrCallback: unknown,
    maybeCallback?: unknown
  ) => {
    const call = { command, args: (Array.isArray(args) ? args : []) as string[] };
    execState.calls.push(call);
    type Callback = (error: Error | null, stdout: string, stderr: string) => void;
    const cb = (typeof _optionsOrCallback === "function"
      ? _optionsOrCallback
      : maybeCallback) as Callback;
    try {
      const result = execState.responder(call);
      if (result.error) {
        const err = Object.assign(
          new Error(result.error.message),
          { code: result.exit ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
        ) as unknown as NodeJS.ErrnoException & { code: string | number; stdout: string; stderr: string };
        cb(err, result.stdout ?? "", result.stderr ?? "");
        return;
      }
      cb(null, result.stdout ?? "", result.stderr ?? "");
    } catch (error) {
      cb(error as Error, "", "");
    }
  };

  const promisifiedExecFile = (command: string, args?: readonly string[], options?: unknown) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(command, args ?? [], options ?? {}, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  for (const sym of realSymbols) {
    (mockExecFile as unknown as Record<symbol, unknown>)[sym] = promisifiedExecFile;
  }

  return {
    ...actual,
    execFile: mockExecFile
  };
});

// ── Mock node:fs/promises ──────────────────────────────────────────────────
// networking.ts reads /proc files. We provide a mock that returns whatever
// the test wants via a per-test virtual filesystem (kept in fsState).
const fsState = vi.hoisted(() => ({
  procFiles: new Map<string, string>()
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const readFileImpl = async (target: string, _encoding?: string): Promise<string | Buffer> => {
    if (fsState.procFiles.has(target)) {
      return fsState.procFiles.get(target)!;
    }
    const err = new Error(`ENOENT: no such file or directory, open '${target}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  const writeFileImpl = async (target: string, content: string | Buffer): Promise<void> => {
    fsState.procFiles.set(target, typeof content === "string" ? content : content.toString("utf8"));
  };
  return {
    ...actual,
    readFile: readFileImpl,
    writeFile: writeFileImpl
  };
});

// Imports deferred until after the mocks are registered.
const networkingModule = await import("../../packages/engine/src/networking.js");
type EngineConfig = import("../../packages/engine/src/types.js").EngineConfig;
type EngineState = import("../../packages/engine/src/types.js").EngineState;

const {
  applyNetworking,
  checkForwardingEnabled,
  checkNatRulePresent,
  detectEgressInterface,
  planNetworking
} = networkingModule;

function buildConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    env: "production",
    port: 9090,
    dataDir: "/var/lib/kintunnel",
    statePath: "/var/lib/kintunnel/state.json",
    dryRun: false,
    apiToken: "test-token",
    interfaceName: "wg0",
    listenPort: 51820,
    endpointHost: "vpn.example.test",
    endpointPort: 51820,
    tunnelCidrV4: "10.55.0.0/29",
    defaultAllowedIps: ["0.0.0.0/0"],
    defaultDnsServers: ["1.1.1.1"],
    persistentKeepalive: 25,
    natEnabled: true,
    forwardingRequired: true,
    natApply: true,
    backupDir: "/backups",
    backupRetentionCount: 10,
    backupLockTimeoutMs: 30_000,
    applyBootstrapTimeoutMs: 15_000,
    ...overrides
  };
}

function buildState(): EngineState {
  return {
    version: 1,
    revision: 1,
    server: {
      interfaceName: "wg0",
      listenPort: 51820,
      endpointHost: "vpn.example.test",
      endpointPort: 51820,
      tunnelCidrV4: "10.55.0.0/29",
      serverAddressV4: "10.55.0.1/32",
      serverPublicKey: "SERVERPUB",
      serverPrivateKey: "SERVERPRIV",
      defaultAllowedIps: ["0.0.0.0/0"],
      defaultDnsServers: ["1.1.1.1"],
      persistentKeepalive: 25,
      natEnabled: true,
      forwardingRequired: true,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    peers: [],
    events: []
  };
}

describe("networking.ts", () => {
  beforeEach(() => {
    execState.calls.length = 0;
    execState.responder = () => ({ stdout: "", stderr: "", exit: 0 });
    fsState.procFiles.clear();
  });

  describe("detectEgressInterface", () => {
    it("returns the iface with default route", async () => {
      // /proc/net/route format: Iface | Destination | Gateway | Flags | RefCnt | Use | Metric | Mask | MTU | Window | IRTT
      fsState.procFiles.set(
        "/proc/net/route",
        [
          "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
          "eth0\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\t0\t0\t0",
          "wg0\t0000000A\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0"
        ].join("\n")
      );

      const iface = await detectEgressInterface();

      expect(iface).toBe("eth0");
    });

    it("returns undefined when no default route", async () => {
      fsState.procFiles.set(
        "/proc/net/route",
        [
          "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
          "wg0\t0000000A\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0"
        ].join("\n")
      );

      const iface = await detectEgressInterface();

      expect(iface).toBeUndefined();
    });

    it("returns undefined when proc is unreadable", async () => {
      // /proc/net/route NOT in fsState.procFiles → readFile throws ENOENT.
      const iface = await detectEgressInterface();
      expect(iface).toBeUndefined();
    });
  });

  describe("planNetworking", () => {
    it("includes all 4 rules when natEnabled && natApply", () => {
      const plan = planNetworking(buildConfig({ natEnabled: true, natApply: true }), buildState());

      expect(plan.masqueradeRule).toBe(true);
      expect(plan.enableForwarding).toBe(true);
      expect(plan.forwardRules.allowTunnelNew).toBe(true);
      expect(plan.forwardRules.allowEstablishedRelated).toBe(true);
      expect(plan.forwardRules.dropInvalid).toBe(true);
    });

    it("returns the same plan regardless of natApply (apply gating is in applyNetworking)", () => {
      // The plan shape is identical whether natApply is on or off; the gate
      // is enforced inside applyNetworking's early-return. Tests that exercise
      // the gate live in the applyNetworking describe block below.
      const on = planNetworking(buildConfig({ natEnabled: true, natApply: true }), buildState());
      const off = planNetworking(buildConfig({ natEnabled: true, natApply: false }), buildState());
      expect(on).toEqual(off);
    });
  });

  describe("applyNetworking", () => {
    beforeEach(() => {
      // Default: iptables is available and ip_forward is "0" so applyNetworking
      // has something to enable. Egress is auto-resolved from /proc/net/route.
      // Note: networking's `execIptables` surfaces the iptables exit code via
      // the `.code` property of the rejected error from execFile. Our mock
      // surfaces `responder(...).exit` on the error, so a non-zero exit
      // requires the responder to set `error` (which propagates to `.code`).
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args[0] === "--version") {
          return { stdout: "iptables v1.8", stderr: "", exit: 0 };
        }
        // -C (check) returns exit 1 by default → rule is absent → -A (insert) runs.
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { error: new Error("rule not present"), exit: 1, stderr: "rule not present" };
        }
        if (call.command === "iptables" && (call.args.includes("-A") || call.args.includes("-D"))) {
          return { stdout: "", stderr: "", exit: 0 };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "0");
      fsState.procFiles.set(
        "/proc/net/route",
        [
          "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
          "eth0\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\t0\t0\t0"
        ].join("\n")
      );
    });

    it("returns empty plan when natApply is false", async () => {
      const config = buildConfig({ natApply: false });
      const result = await applyNetworking(config, planNetworking(config, buildState()), buildState());

      expect(result.applied).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.rulesInserted).toEqual([]);
      // No iptables invocations at all.
      const iptablesCalls = execState.calls.filter((c) => c.command === "iptables");
      expect(iptablesCalls).toHaveLength(0);
    });

    it("runs -C before -A for each rule (4 inserts)", async () => {
      const config = buildConfig({ natEnabled: true, natApply: true });
      const result = await applyNetworking(config, planNetworking(config, buildState()), buildState());

      const checkCalls = execState.calls.filter((c) => c.command === "iptables" && c.args.includes("-C"));
      const insertCalls = execState.calls.filter((c) => c.command === "iptables" && c.args.includes("-A"));
      expect(checkCalls.length).toBe(4);
      expect(insertCalls.length).toBe(4);
      // Comment markers preserved verbatim.
      const markers = insertCalls.map((c) => {
        const idx = c.args.indexOf("--comment");
        return c.args[idx + 1];
      });
      expect(markers).toEqual(
        expect.arrayContaining([
          "kintunnel:fwd:allow-estab-related",
          "kintunnel:fwd:allow-tunnel-new",
          "kintunnel:fwd:drop-invalid",
          "kintunnel:nat:masquerade"
        ])
      );
      expect(result.rulesInserted).toHaveLength(4);
    });

    it("skips -A when -C returns 0 (idempotency)", async () => {
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args[0] === "--version") {
          return { stdout: "iptables v1.8", stderr: "", exit: 0 };
        }
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { stdout: "", stderr: "", exit: 0 }; // rule already present → no error
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const config = buildConfig({ natEnabled: true, natApply: true });
      const result = await applyNetworking(config, planNetworking(config, buildState()), buildState());

      const insertCalls = execState.calls.filter((c) => c.command === "iptables" && c.args.includes("-A"));
      expect(insertCalls).toHaveLength(0);
      expect(result.rulesInserted).toHaveLength(4);
    });

    it("rolls back partial apply when MASQ insert fails", async () => {
      let iptablesACallCount = 0;
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args[0] === "--version") {
          return { stdout: "iptables v1.8", stderr: "", exit: 0 };
        }
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { error: new Error("rule not present"), exit: 1, stderr: "rule not present" };
        }
        if (call.command === "iptables" && call.args.includes("-A")) {
          iptablesACallCount += 1;
          // The MASQUERADE rule is the 4th insertion; let the first 3 succeed.
          if (iptablesACallCount === 4) {
            return { error: new Error("permission denied"), exit: 1, stderr: "permission denied" };
          }
          return { stdout: "", stderr: "", exit: 0 };
        }
        // -D is best-effort; succeed when called.
        if (call.command === "iptables" && call.args.includes("-D")) {
          return { stdout: "", stderr: "", exit: 0 };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const config = buildConfig({ natEnabled: true, natApply: true });
      const result = await applyNetworking(config, planNetworking(config, buildState()), buildState());

      // Rollback iterates ALL rule specs (best-effort, not just the
      // successful inserts). The result records the rules that WERE
      // successfully inserted (3) as `rulesRolledBack` — the MASQ rule
      // is absent because its insertion failed.
      const deleteCalls = execState.calls.filter((c) => c.command === "iptables" && c.args.includes("-D"));
      expect(deleteCalls.length).toBeGreaterThanOrEqual(3);
      expect(result.rulesRolledBack).toHaveLength(3);
      expect(result.ok).toBe(false);
    });

    it("short-circuits when config.dryRun is true", async () => {
      const config = buildConfig({ dryRun: true, natApply: true });
      const result = await applyNetworking(config, planNetworking(config, buildState()), buildState());

      const iptablesCalls = execState.calls.filter((c) => c.command === "iptables");
      expect(iptablesCalls).toHaveLength(0);
      // In dry-run, insertOutcome is unconditionally "ok" for every managed
      // rule spec (no real exec) — all 4 (3 FORWARD + 1 MASQUERADE) should
      // still be reported as "inserted" so the plan is fully visible.
      expect(result.rulesInserted).toHaveLength(4);
    });
  });

  describe("checkForwardingEnabled", () => {
    it("returns true when /proc/sys/net/ipv4/ip_forward === '1'", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "1");
      expect(await checkForwardingEnabled()).toBe(true);
    });

    it("returns false when value is '0'", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "0");
      expect(await checkForwardingEnabled()).toBe(false);
    });

    it("returns false when the proc file is missing", async () => {
      // fsState.procFiles doesn't contain ip_forward → readFile throws ENOENT.
      expect(await checkForwardingEnabled()).toBe(false);
    });
  });

  describe("checkNatRulePresent", () => {
    it("returns true when iptables exits 0", async () => {
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { stdout: "", stderr: "", exit: 0 };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      expect(await checkNatRulePresent("wg0", "10.55.0.0/29", "eth0")).toBe(true);
    });

    it("returns false when iptables exits non-zero", async () => {
      // networking's execIptables treats any iptables failure (non-zero exit)
      // as a thrown error with `.code = exit`. The check returns false.
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { error: new Error("rule not present"), exit: 1, stderr: "rule not present" };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      expect(await checkNatRulePresent("wg0", "10.55.0.0/29", "eth0")).toBe(false);
    });

    it("returns false when iptables throws", async () => {
      execState.responder = (call) => {
        if (call.command === "iptables" && call.args.includes("-C")) {
          return { error: new Error("iptables missing") };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      expect(await checkNatRulePresent("wg0", "10.55.0.0/29", "eth0")).toBe(false);
    });
  });
});
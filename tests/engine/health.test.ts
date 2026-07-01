import { constants as fsConstants } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// ── Mock node:child_process ────────────────────────────────────────────────
// health.ts calls execFile via `execHost`. We mirror the custom
// promisify symbol so destructuring `{ stdout, stderr }` from the
// resolved promise keeps working — see apply.test.ts for the rationale.
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
// health.ts reads /proc/sys/net/ipv4/ip_forward and accesses /dev/net/tun
// via fs.access. We provide a per-test virtual proc filesystem and a
// per-test tun-accessibility flag.
const fsState = vi.hoisted(() => ({
  procFiles: new Map<string, string>(),
  tunReadable: true,
  accessCalls: [] as Array<{ target: string; mode?: number }>
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
  const accessImpl = async (target: string, mode?: number): Promise<void> => {
    fsState.accessCalls.push({ target, mode });
    if (target === "/dev/net/tun") {
      if (!fsState.tunReadable) {
        const err = new Error(`EACCES: permission denied, access '${target}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return;
    }
    // For other access calls (e.g. statePath), call the real implementation.
    return actual.access(target, mode);
  };
  return {
    ...actual,
    readFile: readFileImpl,
    access: accessImpl
  };
});

// Imports deferred until after the mocks are registered.
const healthModule = await import("../../packages/engine/src/health.js");
type EngineConfig = import("../../packages/engine/src/types.js").EngineConfig;
type EngineState = import("../../packages/engine/src/types.js").EngineState;

const {
  checkForwarding,
  checkInterface,
  checkIptables,
  checkPortReachability,
  checkStateIo,
  checkTun,
  runHealthChecks
} = healthModule;

function buildConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    env: "production",
    port: 9090,
    dataDir: "/var/lib/kintunnel",
    statePath: "/var/lib/kintunnel/state.json",
    dryRun: false,
    apiToken: "test-token-health-32chars-or-more-123",
    interfaceName: "wg0",
    listenPort: 51820,
    endpointHost: "vpn.example.test",
    endpointPort: 51820,
    tunnelCidrV4: "10.55.0.0/29",
    defaultAllowedIps: ["0.0.0.0/0"],
    defaultDnsServers: ["1.1.1.1"],
    persistentKeepalive: 0,
    natEnabled: true,
    forwardingRequired: true,
    natApply: false,
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
      persistentKeepalive: 0,
      natEnabled: true,
      forwardingRequired: true,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    peers: [],
    events: []
  };
}

describe("health.ts", () => {
  beforeEach(() => {
    execState.calls.length = 0;
    execState.responder = () => ({ stdout: "", stderr: "", exit: 0 });
    fsState.procFiles.clear();
    fsState.tunReadable = true;
    fsState.accessCalls.length = 0;
  });

  describe("checkTun", () => {
    it("returns pass when /dev/net/tun is readable", async () => {
      fsState.tunReadable = true;
      const result = await checkTun();
      expect(result.name).toBe("tun");
      expect(result.status).toBe("pass");
    });

    it("returns fail when /dev/net/tun is unreadable", async () => {
      fsState.tunReadable = false;
      const result = await checkTun();
      expect(result.name).toBe("tun");
      expect(result.status).toBe("fail");
    });

    it("does NOT open for write (R_OK only)", async () => {
      // Opening /dev/net/tun for write would consume the device — checkTun
      // must probe with R_OK only, never W_OK, regardless of pass/fail.
      fsState.tunReadable = true;
      const result = await checkTun();
      expect(result.status).toBe("pass");
      expect(result.detail).toContain("/dev/net/tun");

      const tunCall = fsState.accessCalls.find((call) => call.target === "/dev/net/tun");
      expect(tunCall).toBeDefined();
      expect(tunCall!.mode).toBe(fsConstants.R_OK);
      expect((tunCall!.mode ?? 0) & fsConstants.W_OK).toBe(0);
    });
  });

  describe("checkForwarding", () => {
    it("returns pass when ip_forward === '1'", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "1");
      const result = await checkForwarding();
      expect(result.name).toBe("forwarding");
      expect(result.status).toBe("pass");
    });

    it("returns fail when ip_forward === '0'", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "0");
      const result = await checkForwarding();
      expect(result.name).toBe("forwarding");
      expect(result.status).toBe("fail");
    });
  });

  describe("checkInterface", () => {
    it("returns pass when wg show first row port matches state.server.listenPort", async () => {
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return {
            stdout: "SERVERPUB\tSECRET\t51820\t1",
            stderr: "",
            exit: 0
          };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const result = await checkInterface(buildState());
      expect(result.name).toBe("interface");
      expect(result.status).toBe("pass");
    });

    it("returns fail on port mismatch", async () => {
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return {
            stdout: "SERVERPUB\tSECRET\t61999\t1",
            stderr: "",
            exit: 0
          };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const result = await checkInterface(buildState());
      expect(result.name).toBe("interface");
      expect(result.status).toBe("fail");
      expect(result.detail).toMatch(/port mismatch|listen_port/);
    });
  });

  describe("runHealthChecks", () => {
    it("aggregates ok=true when all required checks pass", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "1");
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return { stdout: "SERVERPUB\tSECRET\t51820\t1", stderr: "", exit: 0 };
        }
        if (call.command === "iptables") {
          return { stdout: "", stderr: "", exit: 0 };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const config = buildConfig({
        dryRun: false,
        natEnabled: false,
        natApply: false,
        forwardingRequired: true
      });
      const report = await runHealthChecks(config, buildState());

      expect(report.ok).toBe(true);
      const failing = (report as { required_failing: string[] }).required_failing;
      expect(failing).toEqual([]);
    });

    it("aggregates ok=false when a required check fails (tun)", async () => {
      fsState.procFiles.set("/proc/sys/net/ipv4/ip_forward", "1");
      fsState.tunReadable = false;
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return { stdout: "SERVERPUB\tSECRET\t51820\t1", stderr: "", exit: 0 };
        }
        if (call.command === "iptables") {
          return { stdout: "", stderr: "", exit: 0 };
        }
        return { stdout: "", stderr: "", exit: 0 };
      };

      const config = buildConfig({
        dryRun: false,
        forwardingRequired: true
      });
      const report = await runHealthChecks(config, buildState());

      expect(report.ok).toBe(false);
      const failing = (report as { required_failing: string[] }).required_failing;
      expect(failing).toContain("tun");
    });

    it("short-circuits host checks under dry-run (status='skip')", async () => {
      const config = buildConfig({ dryRun: true });
      const report = await runHealthChecks(config, buildState());

      expect(report.dry_run).toBe(true);
      // Every host check should have status === "skip" except state_io.
      const hostChecks = report.checks.filter((c) => c.name !== "state_io");
      for (const check of hostChecks) {
        expect(check.status).toBe("skip");
      }
      // state_io still ran (default behaviour is that state_io is always
      // checked; in dry-run it's not skipped).
      const stateIoCheck = report.checks.find((c) => c.name === "state_io");
      expect(stateIoCheck).toBeDefined();
      expect(stateIoCheck?.status).not.toBe("skip");
    });

    it("state_io is the only check that runs under dry-run", async () => {
      const config = buildConfig({ dryRun: true });
      const report = await runHealthChecks(config, buildState());

      const ranNames = report.checks.filter((c) => c.status !== "skip").map((c) => c.name);
      // state_io is the only check not under the dry-run short-circuit.
      expect(ranNames).toEqual(["state_io"]);
    });

    it("reports include checks in the documented order", async () => {
      const config = buildConfig({ dryRun: true });
      const report = await runHealthChecks(config, buildState());

      const order = report.checks.map((c) => c.name);
      expect(order).toEqual([
        "tun",
        "forwarding",
        "interface",
        "nat",
        "iptables",
        "port",
        "state_io"
      ]);
    });

    it("checkStateIo returns pass when state file is missing (engine will create)", async () => {
      const config = buildConfig({ statePath: "/tmp/kintunnel-does-not-exist/state.json" });
      const result = await checkStateIo(config);
      expect(result.status).toBe("pass");
      expect(result.required).toBe(true);
    });
  });
});

// Re-import beforeEach shim so the describe block sees reset state.
import { beforeEach } from "vitest";
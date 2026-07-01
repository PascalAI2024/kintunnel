import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Per-test mutable state shared with the mock factories ─────────────────
// vi.mock factories are hoisted to the top of the file BEFORE module
// imports, so they cannot reference top-level `let` variables directly.
// `vi.hoisted` lets us declare a mutable object whose fields are mutated
// inside beforeEach and read by the factory at call time.
const fsState = vi.hoisted(() => ({ tempDir: "" }));
const execState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  responder: (_call: { command: string; args: string[] }) =>
    ({ stdout: "", stderr: "" }) as { stdout?: string; stderr?: string; error?: Error }
}));

// ── Mock node:child_process ────────────────────────────────────────────────
// `apply.ts` resolves `child_process.execFile` at module load via
// `promisify(execFile)`. We replace the underlying `execFile` so we can
// control what each wg / ip invocation returns. The mock records every
// call so individual tests can assert on order and arguments.
//
// Note: Node's built-in execFile has a custom `[Symbol.for("nodejs.util.promisify.custom")]`
// property that tells `util.promisify` to use a special async wrapper. If
// we drop that symbol, `promisify(execFile)` returns just the second
// callback argument instead of `{stdout, stderr}` — which would break
// every callsite in the engine that destructures `await execFileAsync(...)`
// into `{ stdout }`. We mirror the symbol on our mock and point it at a
// promisified wrapper that wraps our callback-style mock.
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
        // Match the err shape that real execFile throws on non-zero exits:
        // `code` may be a number (exit code) or a string (signal/symbol).
        // The cast goes through `unknown` because ErrnoException.code is
        // typed `string | undefined` in @types/node but real execFile
        // errors carry numeric codes too.
        const err = Object.assign(
          new Error(result.error.message),
          { code: 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
        ) as unknown as NodeJS.ErrnoException & { code: string | number; stdout: string; stderr: string };
        cb(err, err.stdout ?? "", err.stderr ?? "");
        return;
      }
      cb(null, result.stdout ?? "", result.stderr ?? "");
    } catch (error) {
      cb(error as Error, "", "");
    }
  };

  // Promisified wrapper that delegates to the callback-style mock.
  const promisifiedExecFile = (command: string, args?: readonly string[], options?: unknown) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(command, args ?? [], options ?? {}, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  // Attach the custom symbol(s) to our mock so util.promisify uses ours.
  for (const sym of realSymbols) {
    (mockExecFile as unknown as Record<symbol, unknown>)[sym] = promisifiedExecFile;
  }

  return {
    ...actual,
    execFile: mockExecFile
  };
});

// ── Mock node:fs/promises ──────────────────────────────────────────────────
// Apply writes its flock under /var/run and temp INI files under
// /var/run/kintunnel, both unwritable as a non-root user. We redirect any
// path under /var into a per-test temp directory before delegating to the
// real fs implementation.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const redirectUnderVar = (target: string): string => {
    const base = fsState.tempDir;
    if (!base) return target;
    if (target.startsWith("/var/run/")) {
      return path.join(base, "var-run", target.slice("/var/run/".length));
    }
    if (target.startsWith("/var/")) {
      return path.join(base, "var", target.slice("/var/".length));
    }
    return target;
  };
  return {
    ...actual,
    mkdir: (target: string, opts?: { recursive?: boolean }) =>
      actual.mkdir(redirectUnderVar(target), opts),
    open: (target: string, mode?: string) => actual.open(redirectUnderVar(target), mode),
    writeFile: (target: string, content: string | Buffer, opts?: unknown) =>
      actual.writeFile(redirectUnderVar(target), content, opts as never),
    rename: (from: string, to: string) =>
      actual.rename(redirectUnderVar(from), redirectUnderVar(to)),
    unlink: (target: string) => actual.unlink(redirectUnderVar(target)),
    rm: (target: string, opts?: { recursive?: boolean; force?: boolean }) =>
      actual.rm(redirectUnderVar(target), opts),
    stat: (target: string) => actual.stat(redirectUnderVar(target)),
    readFile: actual.readFile,
    readdir: actual.readdir,
    access: actual.access,
    appendFile: actual.appendFile,
    copyFile: actual.copyFile,
    realpath: actual.realpath
  };
});

// ── Mock ./state.js to bypass the withFileLock primitive ──────────────────
// apply.ts takes a BSD flock on /var/run/kintunnel-apply.lock before any
// host exec. Real flock acquisition requires elevated privileges on the
// underlying inode, so we substitute a passthrough implementation that
// executes the inner function directly. The lock is real in production;
// here we only care about the sequencing and side effects inside.
vi.mock("../../packages/engine/src/state.js", async () => {
  const actual = await vi.importActual<any>("../../packages/engine/src/state.js");
  return {
    ...actual,
    withFileLock: async (_path: string, fn: () => Promise<unknown>) => fn()
  };
});

// Imports deferred until after the mocks are registered.
const applyModule = await import("../../packages/engine/src/apply.js");
type RuntimeState = import("../../packages/engine/src/runtime.js").RuntimeState;
type EngineState = import("../../packages/engine/src/types.js").EngineState;
type PeerRecord = import("../../packages/engine/src/types.js").PeerRecord;

const { ApplyError, diffPeers, executeApply, planApply, renderWgIni } = applyModule;

function buildActivePeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    id: overrides.id ?? "peer-1",
    name: overrides.name ?? "alice-phone",
    publicKey: overrides.publicKey ?? "PUBKEY_ALICE",
    addressV4: overrides.addressV4 ?? "10.55.0.2/32",
    allowedIps: overrides.allowedIps ?? ["10.0.0.0/24"],
    dnsServers: overrides.dnsServers ?? ["1.1.1.1"],
    persistentKeepalive: overrides.persistentKeepalive ?? 0,
    status: overrides.status ?? "active",
    expiresAt: overrides.expiresAt,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z"
  };
}

function buildState(peers: PeerRecord[]): EngineState {
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
    peers,
    events: []
  };
}

function buildRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    interfaceName: "wg0",
    exists: overrides.exists ?? true,
    listenPort: overrides.listenPort ?? 51820,
    peers: overrides.peers ?? [],
    rawAvailable: overrides.rawAvailable ?? true
  };
}

describe("apply.ts", () => {
  beforeEach(async () => {
    fsState.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kintunnel-apply-"));
    execState.calls.length = 0;
    execState.responder = () => ({ stdout: "", stderr: "" });
    delete process.env.KINTUNNEL_ENABLE_HOST_NETWORKING;
  });

  afterEach(async () => {
    await fs.rm(fsState.tempDir, { recursive: true, force: true }).catch(() => undefined);
    fsState.tempDir = "";
  });

  describe("planApply", () => {
    it("returns bootstrap=true when interface absent", () => {
      const state = buildState([buildActivePeer()]);
      const runtime = buildRuntime({ exists: false, peers: [] });

      const plan = planApply(state, runtime);

      expect(plan.bootstrap).toBe(true);
      expect(plan.reconfigureInterface).toBe(false);
      // peer removals are not relevant on bootstrap — the peer diff is
      // computed by diffPeers on the live path, not by planApply.
      expect(plan.removePeers).toEqual([]);
    });

    it("returns warm path with peer diff when interface exists", () => {
      const state = buildState([
        buildActivePeer({ publicKey: "PUBKEY_A" }),
        buildActivePeer({ id: "peer-2", name: "bob", publicKey: "PUBKEY_B", addressV4: "10.55.0.3/32" })
      ]);
      const runtime = buildRuntime({
        exists: true,
        peers: [{ publicKey: "PUBKEY_A", allowedIps: ["10.55.0.2/32"] }]
      });

      const plan = planApply(state, runtime);

      expect(plan.bootstrap).toBe(false);
      expect(plan.addPeers).toEqual(["PUBKEY_B"]);
      expect(plan.removePeers).toEqual([]);
    });
  });

  describe("executeApply dry-run", () => {
    it("does NOT invoke any exec call when dryRun=true", async () => {
      const state = buildState([buildActivePeer()]);
      const result = await executeApply({ state, dryRun: true });

      expect(result.applied).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.bootstrap).toBe(false); // dry-run baseline treats runtime as exists=true
      expect(execState.calls).toHaveLength(0);
    });
  });

  describe("executeApply live path", () => {
    beforeEach(() => {
      process.env.KINTUNNEL_ENABLE_HOST_NETWORKING = "true";
    });

    it("throws ApplyError(capability_missing) when wg is unavailable", async () => {
      // executeApply doesn't itself check capabilities — that gate lives
      // in reconcile() — but it WILL fail when getRuntimeState's wg show
      // probe throws because there is no wg binary on PATH. Surface that
      // error as a thrown Error (caller is responsible for surfacing
      // capability_missing; here we just confirm the surface area).
      execState.responder = () => ({ error: new Error("wg not on PATH") });

      const state = buildState([buildActivePeer()]);
      await expect(executeApply({ state, dryRun: false })).rejects.toThrow();
    });

    it("runs bootstrap sequence in the right order", async () => {
      execState.responder = (call) => {
        // getRuntimeState's wg show dump returns empty → exists=false → bootstrap path.
        if (call.command === "wg" && call.args[0] === "show") {
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };

      const state = buildState([buildActivePeer()]);
      const result = await executeApply({ state, dryRun: false });

      const recorded = execState.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
      const addIdx = recorded.findIndex((c) => c.startsWith("ip link add wg0 type wireguard"));
      const setconfIdx = recorded.findIndex((c) => c.startsWith("wg setconf wg0 "));
      const addrIdx = recorded.findIndex((c) => c.startsWith("ip addr replace 10.55.0.1/32 dev wg0"));
      const upIdx = recorded.findIndex((c) => c.startsWith("ip link set dev wg0 mtu "));

      expect(addIdx).toBeGreaterThanOrEqual(0);
      expect(setconfIdx).toBeGreaterThan(addIdx);
      expect(addrIdx).toBeGreaterThan(setconfIdx);
      expect(upIdx).toBeGreaterThan(addrIdx);
      expect(result.bootstrap).toBe(true);
    });

    it("calls ip link del on bootstrap failure (best-effort rollback)", async () => {
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return { stdout: "", stderr: "" }; // exists=false → bootstrap path
        }
        if (call.command === "wg" && call.args[0] === "setconf") {
          return { error: new Error("setconf failed") };
        }
        return { stdout: "", stderr: "" };
      };

      const state = buildState([buildActivePeer()]);
      try {
        await executeApply({ state, dryRun: false });
        throw new Error("Expected executeApply to throw");
      } catch {
        // expected
      }

      const linkDelCall = execState.calls.find(
        (call) =>
          call.command === "ip" &&
          call.args.includes("del") &&
          call.args.includes("wg0")
      );
      expect(linkDelCall).toBeDefined();
    });

    it("uses wg syncconf on the warm path", async () => {
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return {
            stdout: [
              "SERVERPUB\tSECRET\t51820\t1",
              "PUBKEY_A\tPSK_A\t(endpoint)\t10.55.0.2/32\t0\t0\t0\toff"
            ].join("\n"),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      const state = buildState([
        buildActivePeer({ publicKey: "PUBKEY_A" }),
        buildActivePeer({ id: "peer-2", name: "bob", publicKey: "PUBKEY_B", addressV4: "10.55.0.3/32" })
      ]);

      await executeApply({ state, dryRun: false });

      const syncconfCalls = execState.calls.filter(
        (call) => call.command === "wg" && call.args[0] === "syncconf"
      );
      expect(syncconfCalls.length).toBe(1);
      expect(syncconfCalls[0].args[2]).toMatch(/\/var\/run\/kintunnel\/wg-.*\.ini/);
    });

    it("uses wg set ... peer ... remove for removed peers", async () => {
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          return {
            stdout: [
              "SERVERPUB\tSECRET\t51820\t1",
              "PUBKEY_KEPT\tPSK\t(endpoint)\t10.55.0.2/32\t0\t0\t0\toff",
              "PUBKEY_GONE\tPSK\t(endpoint)\t10.55.0.99/32\t0\t0\t0\toff"
            ].join("\n"),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      const state = buildState([
        buildActivePeer({ publicKey: "PUBKEY_KEPT" })
      ]);

      await executeApply({ state, dryRun: false });

      const removeCalls = execState.calls.filter(
        (call) =>
          call.command === "wg" &&
          call.args[0] === "set" &&
          call.args.includes("remove")
      );
      expect(removeCalls.length).toBeGreaterThanOrEqual(1);
      const matching = removeCalls.find(
        (call) => call.args[3] === "PUBKEY_GONE"
      );
      expect(matching).toBeDefined();
    });

    it("detects listenPort drift and surfaces ApplyError via errors[]", async () => {
      let showInvocationCount = 0;
      execState.responder = (call) => {
        if (call.command === "wg" && call.args[0] === "show") {
          showInvocationCount += 1;
          if (showInvocationCount === 1) {
            // getRuntimeState probe — same port so the warm path runs.
            return {
              stdout: "SERVERPUB\tSECRET\t51820\t1\nPUBKEY_A\tPSK\t(endpoint)\t10.55.0.2/32\t0\t0\t0\toff",
              stderr: ""
            };
          }
          // Drift detection probe — mismatched port.
          return {
            stdout: "SERVERPUB\tSECRET\t61999\t1",
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      };

      const state = buildState([buildActivePeer({ publicKey: "PUBKEY_A" })]);
      const result = await executeApply({ state, dryRun: false });

      const driftMessages = result.errors.filter((msg) => msg.toLowerCase().includes("drift"));
      expect(driftMessages.length).toBeGreaterThan(0);
      expect(result.drift?.detected).toBe(true);
      expect(result.drift?.fields).toContain("listenPort");
      // apply.rollback.executed should be in the events list.
      const rollbackEvent = (state.events ?? []).find((event) => event.action === "apply.rollback.executed");
      expect(rollbackEvent).toBeDefined();
    });
  });

  describe("diffPeers", () => {
    it("returns the expected add/remove/modify sets", async () => {
      const intended: PeerRecord[] = [
        buildActivePeer({ publicKey: "KEEP", addressV4: "10.55.0.2/32" }),
        buildActivePeer({ id: "peer-new", name: "new", publicKey: "ADD", addressV4: "10.55.0.3/32" }),
        buildActivePeer({
          id: "peer-changed",
          name: "changed",
          publicKey: "CHANGED",
          addressV4: "10.55.0.4/32",
          persistentKeepalive: 25
        })
      ];
      const current: RuntimeState["peers"] = [
        { publicKey: "KEEP", allowedIps: ["10.55.0.2/32"] },
        { publicKey: "REMOVE", allowedIps: ["10.55.0.9/32"] },
        // Present on both sides, but the kernel's keepalive doesn't match
        // intended state — must surface as "modify", not silently ignored.
        { publicKey: "CHANGED", allowedIps: ["10.55.0.4/32"], persistentKeepalive: 0 }
      ];

      const diff = await diffPeers(intended, current);

      expect(diff.add).toEqual(["ADD"]);
      expect(diff.remove).toEqual(["REMOVE"]);
      expect(diff.modify).toEqual(["CHANGED"]);
    });
  });

  describe("renderWgIni", () => {
    it("includes [Interface] + [Peer] sections", () => {
      const state = buildState([
        buildActivePeer({ publicKey: "PUBKEY_A", addressV4: "10.55.0.2/32", allowedIps: ["0.0.0.0/0"] })
      ]);

      const ini = renderWgIni(state, true);

      expect(ini).toContain("[Interface]");
      expect(ini).toContain("PrivateKey = SERVERPRIV");
      expect(ini).toContain("ListenPort = 51820");
      expect(ini).toContain("[Peer]");
      expect(ini).toContain("PublicKey = PUBKEY_A");
      expect(ini).toContain("AllowedIPs = 10.55.0.2/32");
    });

    it("scopes each peer's server-side AllowedIPs to its own address, not the client's full-tunnel AllowedIPs", () => {
      // Regression test: every peer defaults to allowedIps=["0.0.0.0/0"]
      // (full tunnel, see .env.example KINTUNNEL_ALLOWED_IPS). Server-side
      // AllowedIPs must be each peer's own /32 — reusing the client's
      // 0.0.0.0/0 for every peer would make WireGuard route the shared
      // prefix to whichever peer synced last, breaking all the others.
      const state = buildState([
        buildActivePeer({ publicKey: "PUBKEY_A", addressV4: "10.55.0.2/32", allowedIps: ["0.0.0.0/0"] }),
        buildActivePeer({ publicKey: "PUBKEY_B", addressV4: "10.55.0.3/32", allowedIps: ["0.0.0.0/0"] })
      ]);

      const ini = renderWgIni(state, true);

      expect(ini).toContain("PublicKey = PUBKEY_A");
      expect(ini).toContain("PublicKey = PUBKEY_B");
      expect(ini).toContain("AllowedIPs = 10.55.0.2/32");
      expect(ini).toContain("AllowedIPs = 10.55.0.3/32");
      expect(ini).not.toContain("AllowedIPs = 0.0.0.0/0");
    });
  });
});
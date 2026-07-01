import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../../packages/engine/src/state.js";

// Deliberately NOT mocked — apply.test.ts and backup.test.ts both replace
// withFileLock with a passthrough, so this is the only place the real
// locking primitive (plain exclusive-lock-file, not an OS flock — Node's
// fs/promises has no flock API) gets exercised end to end.

let tempDir: string;
let lockPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kintunnel-lock-test-"));
  lockPath = path.join(tempDir, "test.lock");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("runs fn and returns its result", async () => {
    const result = await withFileLock(lockPath, async () => "done", { timeoutMs: 1000 });
    expect(result).toBe("done");
  });

  it("removes the lock file after fn settles (success or failure)", async () => {
    await withFileLock(lockPath, async () => undefined, { timeoutMs: 1000 });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      withFileLock(
        lockPath,
        async () => {
          throw new Error("boom");
        },
        { timeoutMs: 1000 }
      )
    ).rejects.toThrow("boom");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes two concurrent callers on the same lock path", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      const first = withFileLock(
        lockPath,
        async () => {
          order.push("first-start");
          resolve();
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
          order.push("first-end");
        },
        { timeoutMs: 2000 }
      );
      void first;
    });

    await firstStarted;
    const second = withFileLock(
      lockPath,
      async () => {
        order.push("second-start");
      },
      { timeoutMs: 2000 }
    );

    // Give the second caller a moment to poll and confirm it is still
    // blocked while the first holds the lock.
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await second;
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("throws with code=ELOCKTIMEOUT when the lock can't be acquired in time", async () => {
    let releaseHolder: () => void = () => undefined;
    const holderDone = new Promise<void>((resolveDone) => {
      void withFileLock(
        lockPath,
        () =>
          new Promise<void>((r) => {
            releaseHolder = r;
          }).then(() => resolveDone()),
        { timeoutMs: 5000 }
      );
    });

    // Give the holder a moment to actually acquire the lock file first.
    await new Promise((r) => setTimeout(r, 50));

    await expect(
      withFileLock(lockPath, async () => "should not run", { timeoutMs: 200 })
    ).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });

    releaseHolder();
    await holderDone;
  });
});

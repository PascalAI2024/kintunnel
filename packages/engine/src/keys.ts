import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { KeyPair } from "./types.js";

const execFileAsync = promisify(execFile);

function placeholderKey(seed: string): string {
  return createHash("sha256").update(seed).digest("base64");
}

export function dryRunKeyPair(seed: string): KeyPair {
  return {
    privateKey: placeholderKey(`kintunnel:dry-run:private:${seed}`),
    publicKey: placeholderKey(`kintunnel:dry-run:public:${seed}`)
  };
}

export async function generateKeyPair(dryRun: boolean, seed: string): Promise<KeyPair> {
  if (dryRun) return dryRunKeyPair(seed);

  const privateResult = await execFileAsync("wg", ["genkey"], { windowsHide: true });
  const privateKey = privateResult.stdout.trim();
  const publicKey = await derivePublicKey(privateKey);
  return {
    privateKey,
    publicKey
  };
}

async function derivePublicKey(privateKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("wg", ["pubkey"], { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `wg pubkey exited with code ${code}`));
      }
    });

    child.stdin.end(`${privateKey}\n`);
  });
}

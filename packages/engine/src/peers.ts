import { ipv4ToNumber } from "./ip.js";
import type { ApiPeerStatus, PeerRecord } from "./types.js";

const WIREGUARD_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const NAME_PATTERN = /^(?=.{1,120}$)[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// Device labels are shorter than person names so they render nicely in
// admin lists (e.g. "laptop", "Alice's iPhone 14").
const DEVICE_LABEL_PATTERN = /^(?=.{1,40}$)[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/;
// Standard 8-4-4-4-12 hex UUID. Accepts both lower and upper case; mirrors
// the shape produced by `crypto.randomUUID()` so we can validate any UUID
// the engine writes to state.json.
const UUID_PATTERN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Reserved implicit person ID for peers that have no `personId`.
 * NOT stored in `state.persons[]`; the engine only uses it as a bucket
 * label in API responses so clients can render a stable "Unassigned" row.
 */
export const UNASSIGNED_PERSON_ID = "00000000-0000-0000-0000-000000000000";

export function peerApiStatus(peer: PeerRecord, now = new Date()): ApiPeerStatus {
  if (peer.status === "active" && peer.expiresAt && Date.parse(peer.expiresAt) <= now.getTime()) {
    return "expired";
  }
  return peer.status;
}

export function isPeerActive(peer: PeerRecord, now = new Date()): boolean {
  return peerApiStatus(peer, now) === "active";
}

export function validatePeerName(name: string): string | undefined {
  if (hasControlChars(name)) return "must not contain control characters";
  if (!NAME_PATTERN.test(name)) return "must be 1-120 characters using letters, numbers, spaces, dot, underscore, or hyphen";
  return undefined;
}

export function validateWireGuardKey(key: string): string | undefined {
  if (hasControlChars(key)) return "must not contain control characters";
  if (!WIREGUARD_KEY_PATTERN.test(key)) return "must be a WireGuard base64 public key";
  return undefined;
}

export function validateAllowedIp(value: string): string | undefined {
  if (hasControlChars(value)) return "must not contain control characters";
  if (isIpv4Cidr(value) || isIpv6Cidr(value)) return undefined;
  return "must be an IPv4 or IPv6 CIDR";
}

export function validateDnsServer(value: string): string | undefined {
  if (hasControlChars(value)) return "must not contain control characters";
  if (isIpv4Address(value) || isIpv6Address(value) || DOMAIN_PATTERN.test(value)) return undefined;
  return "must be an IP address or DNS hostname";
}

export function validateExpiresAt(value: string): string | undefined {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "must be a valid date";
  if (time <= Date.now()) return "must be in the future";
  return undefined;
}

// ── Person / device validators (P3.1) ──────────────────────────────────────

/** Person display names share peer name rules — 1-120 chars, no control chars. */
export function validatePersonName(name: string): string | undefined {
  if (hasControlChars(name)) return "must not contain control characters";
  if (!NAME_PATTERN.test(name)) return "must be 1-120 characters using letters, numbers, spaces, dot, underscore, or hyphen";
  return undefined;
}

/** Person notes allow 0-2000 chars; control chars are forbidden. */
export function validatePersonNotes(notes: string): string | undefined {
  if (hasControlChars(notes)) return "must not contain control characters";
  if (notes.length > 2000) return "must be at most 2000 characters";
  return undefined;
}

/** Device labels are 1-40 chars; uses the same character class as peer names. */
export function validateDeviceLabel(label: string): string | undefined {
  if (hasControlChars(label)) return "must not contain control characters";
  if (!DEVICE_LABEL_PATTERN.test(label)) return "must be 1-40 characters using letters, numbers, spaces, dot, underscore, or hyphen";
  return undefined;
}

/** Person IDs must be UUID-format (matching crypto.randomUUID() output). */
export function validatePersonId(id: string): string | undefined {
  if (!UUID_PATTERN.test(id)) return "must be a valid UUID";
  return undefined;
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isIpv4Address(value: string): boolean {
  try {
    ipv4ToNumber(value);
    return true;
  } catch {
    return false;
  }
}

function isIpv4Cidr(value: string): boolean {
  const [address, prefixRaw] = value.split("/");
  if (!address || prefixRaw === undefined) return false;
  const prefix = Number.parseInt(prefixRaw, 10);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 && isIpv4Address(address);
}

function isIpv6Address(value: string): boolean {
  return value.includes(":") && /^[0-9A-Fa-f:.]+$/.test(value) && value.split(":").length >= 3;
}

function isIpv6Cidr(value: string): boolean {
  const [address, prefixRaw] = value.split("/");
  if (!address || prefixRaw === undefined) return false;
  const prefix = Number.parseInt(prefixRaw, 10);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128 && isIpv6Address(address);
}

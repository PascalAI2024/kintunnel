import { ipv4ToNumber } from "./ip.js";
import type { ApiPeerStatus, PeerRecord } from "./types.js";

const WIREGUARD_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const NAME_PATTERN = /^(?=.{1,120}$)[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

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

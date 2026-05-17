export interface Ipv4Cidr {
  network: number;
  prefix: number;
  mask: number;
  firstHost: number;
  lastHost: number;
}

export function parseIpv4Cidr(cidr: string): Ipv4Cidr {
  const [address, prefixRaw] = cidr.split("/");
  const prefix = Number.parseInt(prefixRaw ?? "", 10);
  if (!address || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new Error("KINTUNNEL_WG_ADDRESS must be an IPv4 CIDR with prefix between /1 and /30");
  }

  const raw = ipv4ToNumber(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (raw & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return {
    network,
    prefix,
    mask,
    firstHost: (network + 1) >>> 0,
    lastHost: (broadcast - 1) >>> 0
  };
}

export function ipv4ToNumber(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${address}`);
  return parts.reduce((acc, part) => {
    if (!/^\d+$/.test(part)) throw new Error(`Invalid IPv4 address: ${address}`);
    const value = Number.parseInt(part, 10);
    if (value < 0 || value > 255) throw new Error(`Invalid IPv4 address: ${address}`);
    return ((acc << 8) | value) >>> 0;
  }, 0);
}

export function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

export function allocatePeerAddress(cidr: string, existingCidrs: string[]): string {
  const parsed = parseIpv4Cidr(cidr);
  const used = new Set(existingCidrs.map((entry) => ipv4ToNumber(entry.split("/")[0] ?? "")));
  const firstPeer = parsed.firstHost + 1;

  for (let candidate = firstPeer; candidate <= parsed.lastHost; candidate += 1) {
    if (!used.has(candidate)) return `${numberToIpv4(candidate)}/32`;
  }

  throw new Error(`No free peer addresses remain in ${cidr}`);
}

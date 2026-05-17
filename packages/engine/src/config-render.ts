import type { PeerRecord, ServerSettings } from "./types.js";

export function renderClientConfig(peer: PeerRecord, server: ServerSettings): string {
  if (!peer.privateKey) {
    throw new Error("Peer private key is not available; cannot render client config");
  }

  const lines = [
    "[Interface]",
    `PrivateKey = ${peer.privateKey}`,
    `Address = ${peer.addressV4}`
  ];

  if (peer.dnsServers.length > 0) lines.push(`DNS = ${peer.dnsServers.join(", ")}`);
  if (server.mtu) lines.push(`MTU = ${server.mtu}`);

  lines.push(
    "",
    "[Peer]",
    `PublicKey = ${server.serverPublicKey}`,
    `AllowedIPs = ${peer.allowedIps.join(", ")}`,
    `Endpoint = ${server.endpointHost}:${server.endpointPort}`
  );

  if (peer.persistentKeepalive > 0) {
    lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
  }

  return `${lines.join("\n")}\n`;
}

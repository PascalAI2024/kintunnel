import type { AuditEvent, EngineStatus, Peer } from "./types";

export interface LayoutOptions {
  title: string;
  authenticated?: boolean;
  csrfToken?: string;
  error?: string;
  notice?: string;
  content: string;
}

export interface PageOptions {
  csrfToken?: string;
  error?: string;
  notice?: string;
}

export function layout(options: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} - KinTunnel Admin</title>
  <style>
    :root { color-scheme: light; --ink:#17202a; --muted:#5d6d7e; --line:#d8dee6; --panel:#f7f9fb; --accent:#0f766e; --accent-2:#2563eb; --danger:#b42318; --warn:#b54708; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #ffffff; }
    header { border-bottom: 1px solid var(--line); background: #fff; }
    nav { max-width: 1120px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    nav a { color: var(--ink); text-decoration: none; font-weight: 650; }
    nav .links { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }
    h1 { margin: 0 0 18px; font-size: 28px; line-height: 1.15; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    a { color: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: #fff; }
    .panel { border: 1px solid var(--line); border-radius: 8px; padding: 18px; background: var(--panel); }
    .muted { color: var(--muted); }
    .flash { border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; border: 1px solid var(--line); background: #f4fbf9; }
    .error { border-color: #f2b8b5; background: #fff4f2; color: var(--danger); }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background:#fff; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { background: var(--panel); font-size: 13px; color: var(--muted); }
    tr:last-child td { border-bottom: 0; }
    label { display: block; font-weight: 650; margin: 14px 0 6px; }
    input, textarea { width: 100%; max-width: 680px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
    textarea { min-height: 84px; resize: vertical; }
    button, .button { border: 0; border-radius: 6px; padding: 10px 14px; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }
    .button.secondary, button.secondary { background: #344054; }
    button.danger { background: var(--danger); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #0b1220; color: #e9eef7; }
    .qr { width: 220px; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 10px; }
    .stack { display:flex; flex-direction:column; gap:10px; }
    .stat strong { display:block; margin-top:4px; font-size:22px; line-height:1.1; }
    .status-pill { display:inline-block; padding: 3px 8px; border-radius: 999px; background:#eef6f5; color:#0f766e; font-size: 12px; font-weight: 700; }
    .status-pill.revoked { background:#fff7ed; color:var(--warn); }
    .status-pill.deleted { background:#fff1f2; color:var(--danger); }
    .event { border-left:3px solid var(--accent); padding:8px 0 8px 10px; }
    .event strong { display:block; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
    @media (max-width: 860px) { .split { grid-template-columns:1fr; } }
    @media (max-width: 640px) { nav { align-items: flex-start; flex-direction: column; } th:nth-child(3), td:nth-child(3) { display:none; } }
  </style>
</head>
<body>
  <header>
    <nav>
      <a href="/">KinTunnel Admin</a>
      <div class="links">
        ${options.authenticated ? `<a href="/peers/new">Create peer</a><form method="post" action="/logout">${csrfField(options.csrfToken)}<button class="secondary" type="submit">Logout</button></form>` : ""}
      </div>
    </nav>
  </header>
  <main>
    ${options.error ? `<div class="flash error">${escapeHtml(options.error)}</div>` : ""}
    ${options.notice ? `<div class="flash">${escapeHtml(options.notice)}</div>` : ""}
    ${options.content}
  </main>
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return layout({
    title: "Login",
    error,
    content: `<h1>Admin login</h1>
      <form method="post" action="/login" class="panel">
        <label for="token">Admin token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>`
  });
}

export function dashboardPage(status: EngineStatus, peers: Peer[], events: AuditEvent[] = [], options: PageOptions = {}): string {
  return layout({
    title: "Dashboard",
    authenticated: true,
    csrfToken: options.csrfToken,
    notice: options.notice,
    error: options.error,
    content: `<h1>Dashboard</h1>
      ${statusCards(status)}
      <div class="actions"><a class="button" href="/peers/new">Create peer</a></div>
      <div class="split">
        <section>
          <h2>Peers</h2>
          ${peerTable(peers)}
        </section>
        <aside>
          <h2>Recent activity</h2>
          ${eventList(events)}
        </aside>
      </div>`
  });
}

export function newPeerPage(options: PageOptions = {}): string {
  return layout({
    title: "Create peer",
    authenticated: true,
    csrfToken: options.csrfToken,
    error: options.error,
    notice: options.notice,
    content: `<h1>Create peer</h1>
      <form method="post" action="/peers" class="panel">
        ${csrfField(options.csrfToken)}
        <label for="name">Name</label>
        <input id="name" name="name" placeholder="alice-phone" required maxlength="120">
        <label for="public_key">Public key</label>
        <input id="public_key" name="public_key" placeholder="Optional when generating keys server-side">
        <label><input type="checkbox" name="generate_keys" value="true" style="width:auto" checked> Generate keys server-side</label>
        <label for="allowed_ips">Allowed IPs</label>
        <input id="allowed_ips" name="allowed_ips" placeholder="0.0.0.0/0, ::/0">
        <label for="dns_servers">DNS servers</label>
        <input id="dns_servers" name="dns_servers" placeholder="1.1.1.1, 9.9.9.9">
        <label for="expires_at">Expires at</label>
        <input id="expires_at" name="expires_at" type="datetime-local">
        <div class="actions"><button type="submit">Create peer</button><a class="button secondary" href="/">Cancel</a></div>
      </form>`
  });
}

export function peerDetailPage(peer: Peer, options: PageOptions = {}): string {
  return layout({
    title: peer.name,
    authenticated: true,
    csrfToken: options.csrfToken,
    notice: options.notice,
    error: options.error,
    content: `<h1>${escapeHtml(peer.name)}</h1>
      <div class="grid">
        <section class="card">
          <h2>Details</h2>
          <p><strong>Status:</strong> <span class="status-pill">${escapeHtml(peer.status ?? "unknown")}</span></p>
          <p><strong>Address:</strong> ${escapeHtml(peer.address_v4 ?? peer.address_v6 ?? "not assigned")}</p>
          <p><strong>Last handshake:</strong> ${escapeHtml(peer.last_handshake_at ?? "never")}</p>
        </section>
        <section class="card">
          <h2>QR code</h2>
          <div class="actions"><a class="button secondary" href="/peers/${escapeAttribute(peer.id)}/config.png">Open QR</a></div>
        </section>
      </div>
      <h2>Client config</h2>
      <div class="actions">
        <a class="button" href="/peers/${escapeAttribute(peer.id)}/config.conf">Download config</a>
        <form method="post" action="/peers/${escapeAttribute(peer.id)}/revoke">${csrfField(options.csrfToken)}<button class="danger" type="submit">Revoke</button></form>
        <form method="post" action="/peers/${escapeAttribute(peer.id)}/delete">${csrfField(options.csrfToken)}<button class="danger" type="submit">Delete</button></form>
        <a class="button secondary" href="/">Back</a>
      </div>`
  });
}

function csrfField(token?: string): string {
  return token ? `<input type="hidden" name="_csrf" value="${escapeAttribute(token)}">` : "";
}

function statusCards(status: EngineStatus): string {
  const peerCounts = status.peers ?? {};
  const mode = status.dry_run === false ? "host networking" : "dry-run";
  return `<div class="grid">
    <div class="card stat"><div class="muted">Engine</div><strong>${escapeHtml(status.ready === false ? "Not ready" : "Reachable")}</strong><div class="muted">${escapeHtml(mode)}</div></div>
    <div class="card stat"><div class="muted">Interface</div><strong>${escapeHtml(status.interface?.name ?? status.server?.interfaceName ?? "unknown")}</strong><div class="muted">${escapeHtml(String(status.interface?.listen_port ?? status.server?.listenPort ?? "port unknown"))}</div></div>
    <div class="card stat"><div class="muted">Active peers</div><strong>${escapeHtml(String(peerCounts.active ?? 0))}</strong><div class="muted">${escapeHtml(String(peerCounts.total ?? 0))} total</div></div>
    <div class="card stat"><div class="muted">Revision</div><strong>${escapeHtml(String(status.revision ?? "n/a"))}</strong><div class="muted">${escapeHtml(formatDate(status.checked_at))}</div></div>
  </div>`;
}

function peerTable(peers: Peer[]): string {
  if (peers.length === 0) {
    return `<p class="muted">No peers yet.</p>`;
  }

  return `<table>
    <thead><tr><th>Name</th><th>Status</th><th>Address</th><th>Handshake</th></tr></thead>
    <tbody>
      ${peers.map((peer) => `<tr>
        <td><a href="/peers/${escapeAttribute(peer.id)}">${escapeHtml(peer.name)}</a></td>
        <td>${statusPill(peer.status)}</td>
        <td>${escapeHtml(peer.address_v4 ?? peer.address_v6 ?? "")}</td>
        <td>${escapeHtml(peer.last_handshake_at ?? "never")}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function eventList(events: AuditEvent[]): string {
  if (events.length === 0) {
    return `<div class="card muted">No activity recorded yet.</div>`;
  }

  return `<div class="card stack">
    ${events.map((event) => `<div class="event">
      <strong>${escapeHtml(eventLabel(event))}</strong>
      <span class="muted">${escapeHtml(formatDate(event.created_at))}${event.revision ? ` | rev ${escapeHtml(String(event.revision))}` : ""}</span>
    </div>`).join("")}
  </div>`;
}

function eventLabel(event: AuditEvent): string {
  const target = event.target_name ? `: ${event.target_name}` : "";
  return `${event.action.replaceAll(".", " ")}${target}`;
}

function statusPill(status = "unknown"): string {
  const klass = status === "revoked" || status === "deleted" ? ` ${status}` : "";
  return `<span class="status-pill${klass}">${escapeHtml(status)}</span>`;
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

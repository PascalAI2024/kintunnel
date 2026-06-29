import type { AdminPerson, AuditEvent, EngineStatus, Peer, PeerCreateInput } from "./types";

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface EngineClient {
  health(): Promise<EngineStatus>;
  status(): Promise<EngineStatus>;
  listEvents(limit?: number): Promise<AuditEvent[]>;
  listPeers(): Promise<Peer[]>;
  createPeer(input: PeerCreateInput): Promise<Peer>;
  getPeer(id: string): Promise<Peer>;
  getPeerConfig(id: string): Promise<string>;
  revokePeer(id: string): Promise<void>;
  deletePeer(id: string): Promise<void>;
  // P3.4 — expiry automation: list soon-to-expire peers for the banner.
  listExpiring(days?: number): Promise<{
    expiring_soon: Array<{ peer_id: string; name: string; expires_at: string; days_remaining: number }>;
    warn_within_days: number;
    generated_at: string;
  }>;
  // P3.1 — Person CRUD + person-scoped device revocation
  listPersons(filter?: { status?: "active" | "archived" }): Promise<AdminPerson[]>;
  getPerson(id: string): Promise<AdminPerson>;
  createPerson(input: { displayName: string; notes?: string }): Promise<AdminPerson>;
  updatePerson(
    id: string,
    patch: { displayName?: string; notes?: string | null; status?: "active" | "archived" }
  ): Promise<AdminPerson>;
  deletePerson(id: string, options?: { force?: boolean }): Promise<AdminPerson>;
  listPersonDevices(id: string): Promise<Peer[]>;
  revokePersonDevices(id: string): Promise<{
    revoked_count: number;
    already_revoked_count: number;
    revoked_peer_ids: string[];
  }>;
}

export class HttpEngineClient implements EngineClient {
  private readonly baseUrl: URL;
  private apiToken?: string;
  private timeoutMs = 5000;
  private maxBodyBytes = 512 * 1024;

  constructor(engineUrl: string) {
    this.baseUrl = new URL(engineUrl);
  }

  configure(options: { apiToken?: string; timeoutMs?: number; maxBodyBytes?: number }): void {
    this.apiToken = options.apiToken ?? this.apiToken;
    this.timeoutMs = options.timeoutMs ?? this.timeoutMs;
    this.maxBodyBytes = options.maxBodyBytes ?? this.maxBodyBytes;
  }

  async health(): Promise<EngineStatus> {
    return this.requestJson<EngineStatus>(["/api/v1/health", "/v1/health", "/health"]);
  }

  async status(): Promise<EngineStatus> {
    return this.requestJson<EngineStatus>(["/api/v1/status", "/v1/status", "/status", "/api/v1/server/runtime", "/runtime"]);
  }

  async listPeers(): Promise<Peer[]> {
    const body = await this.requestJson<{ peers?: Peer[] } | Peer[]>(["/api/v1/peers", "/v1/peers", "/peers"]);
    return Array.isArray(body) ? body : body.peers ?? [];
  }

  async listEvents(limit = 10): Promise<AuditEvent[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const body = await this.requestJson<{ events?: AuditEvent[] } | AuditEvent[]>([
      `/api/v1/events?limit=${safeLimit}`,
      `/v1/events?limit=${safeLimit}`,
      `/events?limit=${safeLimit}`
    ]);
    return Array.isArray(body) ? body : body.events ?? [];
  }

  async createPeer(input: PeerCreateInput): Promise<Peer> {
    const body = await this.requestJson<{ peer?: Peer } | Peer>(["/api/v1/peers", "/v1/peers", "/peers"], {
      method: "POST",
      body: JSON.stringify(input)
    });
    return unwrapPeer(body);
  }

  async getPeer(id: string): Promise<Peer> {
    const safeId = encodeURIComponent(id);
    const body = await this.requestJson<{ peer?: Peer } | Peer>([`/api/v1/peers/${safeId}`, `/v1/peers/${safeId}`, `/peers/${safeId}`]);
    return unwrapPeer(body);
  }

  async getPeerConfig(id: string): Promise<string> {
    const safeId = encodeURIComponent(id);
    const body = await this.requestText([`/api/v1/peers/${safeId}/config`, `/v1/peers/${safeId}/config`, `/peers/${safeId}/config`]);
    return body;
  }

  async revokePeer(id: string): Promise<void> {
    const safeId = encodeURIComponent(id);
    await this.requestText([`/api/v1/peers/${safeId}/revoke`, `/v1/peers/${safeId}/revoke`, `/peers/${safeId}/revoke`], { method: "POST" });
  }

  async deletePeer(id: string): Promise<void> {
    const safeId = encodeURIComponent(id);
    await this.requestText([`/api/v1/peers/${safeId}`, `/v1/peers/${safeId}`, `/peers/${safeId}`], { method: "DELETE" });
  }

  // ── Expiry methods (P3.4) ───────────────────────────────────────────────

  async listExpiring(days?: number): Promise<{
    expiring_soon: Array<{ peer_id: string; name: string; expires_at: string; days_remaining: number }>;
    warn_within_days: number;
    generated_at: string;
  }> {
    const qs = typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 365
      ? `?days=${days}`
      : "";
    return this.requestJson<{
      expiring_soon: Array<{ peer_id: string; name: string; expires_at: string; days_remaining: number }>;
      warn_within_days: number;
      generated_at: string;
    }>([
      `/api/v1/expiring${qs}`,
      `/v1/expiring${qs}`,
      `/expiring${qs}`
    ]);
  }

  // ── Person methods (P3.1) ───────────────────────────────────────────────

  async listPersons(filter?: { status?: "active" | "archived" }): Promise<AdminPerson[]> {
    const qs = filter?.status ? `?status=${encodeURIComponent(filter.status)}` : "";
    const body = await this.requestJson<{ persons?: AdminPerson[] } | AdminPerson[]>([
      `/api/v1/persons${qs}`,
      `/v1/persons${qs}`,
      `/persons${qs}`
    ]);
    return Array.isArray(body) ? body : body.persons ?? [];
  }

  async getPerson(id: string): Promise<AdminPerson> {
    const safeId = encodeURIComponent(id);
    const body = await this.requestJson<{ person?: AdminPerson } | AdminPerson>([
      `/api/v1/persons/${safeId}`,
      `/v1/persons/${safeId}`,
      `/persons/${safeId}`
    ]);
    return unwrapPersonLike<AdminPerson>(body, "display_name");
  }

  async createPerson(input: { displayName: string; notes?: string }): Promise<AdminPerson> {
    const body = await this.requestJson<{ person?: AdminPerson } | AdminPerson>([
      "/api/v1/persons",
      "/v1/persons",
      "/persons"
    ], {
      method: "POST",
      body: JSON.stringify(input)
    });
    return unwrapPersonLike<AdminPerson>(body, "display_name");
  }

  async updatePerson(
    id: string,
    patch: { displayName?: string; notes?: string | null; status?: "active" | "archived" }
  ): Promise<AdminPerson> {
    const safeId = encodeURIComponent(id);
    // Translate camelCase client input to engine wire format (snake_case).
    const wire: Record<string, unknown> = {};
    if (patch.displayName !== undefined) wire.display_name = patch.displayName;
    if (patch.notes !== undefined) wire.notes = patch.notes;
    if (patch.status !== undefined) wire.status = patch.status;
    const body = await this.requestJson<{ person?: AdminPerson } | AdminPerson>([
      `/api/v1/persons/${safeId}`,
      `/v1/persons/${safeId}`,
      `/persons/${safeId}`
    ], {
      method: "PATCH",
      body: JSON.stringify(wire)
    });
    return unwrapPersonLike<AdminPerson>(body, "display_name");
  }

  async deletePerson(id: string, options?: { force?: boolean }): Promise<AdminPerson> {
    const safeId = encodeURIComponent(id);
    const body = await this.requestJson<{ person?: AdminPerson } | AdminPerson>([
      `/api/v1/persons/${safeId}`,
      `/v1/persons/${safeId}`,
      `/persons/${safeId}`
    ], {
      method: "DELETE",
      body: JSON.stringify(options?.force === true ? { force: true } : {})
    });
    return unwrapPersonLike<AdminPerson>(body, "display_name");
  }

  async listPersonDevices(id: string): Promise<Peer[]> {
    const safeId = encodeURIComponent(id);
    const body = await this.requestJson<{ devices?: Peer[] } | Peer[]>([
      `/api/v1/persons/${safeId}/devices`,
      `/v1/persons/${safeId}/devices`,
      `/persons/${safeId}/devices`
    ]);
    return Array.isArray(body) ? body : body.devices ?? [];
  }

  async revokePersonDevices(id: string): Promise<{
    revoked_count: number;
    already_revoked_count: number;
    revoked_peer_ids: string[];
  }> {
    const safeId = encodeURIComponent(id);
    return this.requestJson<{
      revoked_count: number;
      already_revoked_count: number;
      revoked_peer_ids: string[];
    }>([
      `/api/v1/persons/${safeId}/revoke-devices`,
      `/v1/persons/${safeId}/revoke-devices`,
      `/persons/${safeId}/revoke-devices`
    ], { method: "POST" });
  }

  private async requestJson<T>(paths: string[], init: RequestInit = {}): Promise<T> {
    const text = await this.requestText(paths, init);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EngineError("Engine returned invalid JSON.");
    }
  }

  private async requestText(paths: string[], init: RequestInit = {}): Promise<string> {
    let lastError: EngineError | undefined;

    for (const path of paths) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(new URL(path, this.baseUrl), {
          ...init,
          signal: controller.signal,
          headers: {
            accept: "application/json, text/plain;q=0.9",
            ...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}),
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers
          }
        });

        const body = await response.text();
        if (body.length > this.maxBodyBytes) {
          throw new EngineError("Engine response exceeded size limit.", response.status);
        }
        if (response.ok) {
          return body;
        }

        lastError = new EngineError(extractError(body) ?? `Engine request failed with ${response.status}.`, response.status, safeJson(body));
        if (response.status !== 404 || isDomainNotFound(body)) {
          break;
        }
      } catch (error) {
        const message = error instanceof Error && error.name === "AbortError"
          ? "Engine request timed out."
          : error instanceof Error ? error.message : "Engine request failed.";
        lastError = new EngineError(message);
        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new EngineError("Engine request failed.");
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function extractError(body: string): string | undefined {
  const parsed = safeJson(body);
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = (parsed as { error?: { message?: unknown } }).error;
    return typeof error?.message === "string" ? error.message : undefined;
  }
  return undefined;
}

function isDomainNotFound(body: string): boolean {
  const parsed = safeJson(body);
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = (parsed as { error?: { code?: unknown } }).error;
    return error?.code === "not_found";
  }
  return false;
}

function unwrapPeer(body: { peer?: Peer } | Peer): Peer {
  const wrapped = body as { peer?: unknown };
  if (isPeer(wrapped.peer)) {
    return wrapped.peer;
  }
  return body as Peer;
}

function isPeer(value: unknown): value is Peer {
  return Boolean(value && typeof value === "object" && "id" in value && "name" in value);
}

// Generic unwrapper for /v1/persons responses. The discriminator is the
// snake_case field unique to persons (`display_name`); the engine wraps in
// `{ person }` but tests / older clients may pass the raw object.
function unwrapPersonLike<T>(body: { person?: unknown } | T, discriminator: keyof T): T {
  const wrapped = body as { person?: unknown };
  if (wrapped.person && typeof wrapped.person === "object" && discriminator in (wrapped.person as object)) {
    return wrapped.person as T;
  }
  return body as T;
}

import type { AuditEvent, EngineStatus, Peer, PeerCreateInput } from "./types";

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

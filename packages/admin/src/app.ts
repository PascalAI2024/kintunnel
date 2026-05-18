import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import QRCode from "qrcode";
import type { AdminConfig } from "./config";
import { HttpEngineClient, type EngineClient } from "./engine-client";
import { dashboardPage, loginPage, newPeerPage, peerDetailPage } from "./html";
import type { PeerCreateInput } from "./types";

const SESSION_COOKIE = "kintunnel_admin";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export interface AppOptions {
  config: AdminConfig;
  engine?: EngineClient;
}

export function createApp({ config, engine = new HttpEngineClient(config.engineUrl) }: AppOptions) {
  if (engine instanceof HttpEngineClient) {
    engine.configure({
      apiToken: config.engineApiToken,
      timeoutMs: config.engineTimeoutMs
    });
  }

  const app = express();
  const requireCsrf = requireCsrfForCookieAuth(config.adminToken);

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(securityHeaders);
  app.use(noStoreHeaders);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "kintunnel-admin" });
  });

  app.get("/login", (req, res) => {
    if (isAuthenticated(req, config.adminToken)) {
      res.redirect("/");
      return;
    }
    res.status(200).send(loginPage());
  });

  app.post("/login", (req, res) => {
    const rateKey = req.ip ?? "unknown";
    if (isRateLimited(rateKey)) {
      res.status(429).send(loginPage("Too many failed attempts. Try again shortly."));
      return;
    }

    const submittedToken = typeof req.body.token === "string" ? req.body.token : "";
    if (!safeEqual(submittedToken, config.adminToken)) {
      recordFailedLogin(rateKey);
      res.status(401).send(loginPage("Invalid admin token."));
      return;
    }

    clearFailedLogins(rateKey);
    res.cookie(SESSION_COOKIE, signSession(config.adminToken), {
      httpOnly: true,
      sameSite: "strict",
      secure: config.env === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS
    });
    res.redirect("/");
  });

  app.use(requireAuth(config.adminToken));

  app.post("/logout", requireCsrf, (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect("/login");
  });

  app.get("/", async (req, res) => {
    try {
      const [status, peers, events] = await Promise.all([engine.status(), engine.listPeers(), engine.listEvents(8)]);
      res.send(dashboardPage(status, peers, events, { csrfToken: csrfTokenForRequest(req, config.adminToken) }));
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false, message: publicError(error) }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.get("/peers/new", (req, res) => {
    res.send(newPeerPage({ csrfToken: csrfTokenForRequest(req, config.adminToken) }));
  });

  app.post("/peers", requireCsrf, async (req, res) => {
    const input = parsePeerCreate(req.body);
    if (!input.name) {
      res.status(400).send(newPeerPage({
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: "Peer name is required."
      }));
      return;
    }

    try {
      const peer = await engine.createPeer(input);
      res.redirect(`/peers/${encodeURIComponent(peer.id)}`);
    } catch (error) {
      res.status(502).send(newPeerPage({
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.get("/peers/:id", async (req, res) => {
    try {
      const peer = await engine.getPeer(req.params.id);
      res.send(peerDetailPage(peer, { csrfToken: csrfTokenForRequest(req, config.adminToken) }));
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.get("/peers/:id/config.conf", async (req, res) => {
    try {
      const peer = await engine.getPeer(req.params.id);
      const configText = await engine.getPeerConfig(req.params.id);
      res.type("text/plain");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(peer.name)}.conf"`);
      res.send(configText);
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.get("/peers/:id/config.png", async (req, res) => {
    try {
      const peer = await engine.getPeer(req.params.id);
      const configText = await engine.getPeerConfig(req.params.id);
      const qrPng = await QRCode.toBuffer(configText, { errorCorrectionLevel: "M", margin: 1, width: 220 });
      res.type("png");
      res.setHeader("Content-Disposition", `inline; filename="${safeFilename(peer.name)}-qr.png"`);
      res.send(qrPng);
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.post("/peers/:id/revoke", requireCsrf, async (req, res) => {
    try {
      await engine.revokePeer(req.params.id);
      res.redirect(`/peers/${encodeURIComponent(req.params.id)}`);
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.post("/peers/:id/delete", requireCsrf, async (req, res) => {
    try {
      await engine.deletePeer(req.params.id);
      res.redirect("/");
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], [], {
        csrfToken: csrfTokenForRequest(req, config.adminToken),
        error: publicError(error)
      }));
    }
  });

  app.use((_req, res) => {
    res.status(404).send("Not found.");
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).send(publicError(error));
  });

  return app;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

function noStoreHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex");
  next();
}

function requireAuth(adminToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (authMethod(req, adminToken)) {
      next();
      return;
    }
    res.redirect("/login");
  };
}

function isAuthenticated(req: Request, adminToken: string): boolean {
  return Boolean(authMethod(req, adminToken));
}

function authMethod(req: Request, adminToken: string): "cookie" | "token" | undefined {
  const header = req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const directToken = req.header("x-admin-token");
  if ([bearer, directToken].some((token) => typeof token === "string" && safeEqual(token, adminToken))) {
    return "token";
  }

  const session = sessionCookie(req);
  return session && verifySession(session, adminToken) ? "cookie" : undefined;
}

function requireCsrfForCookieAuth(adminToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (authMethod(req, adminToken) !== "cookie") {
      next();
      return;
    }

    const expected = csrfTokenForRequest(req, adminToken);
    const submitted = submittedCsrfToken(req);
    if (expected && submitted && safeEqual(submitted, expected)) {
      next();
      return;
    }

    res.status(403).send("Forbidden.");
  };
}

function submittedCsrfToken(req: Request): string | undefined {
  const headerToken = req.header("x-csrf-token");
  if (headerToken) return headerToken;
  const bodyToken = req.body?._csrf;
  return typeof bodyToken === "string" ? bodyToken : undefined;
}

function csrfTokenForRequest(req: Request, adminToken: string): string | undefined {
  const session = sessionCookie(req);
  return session && verifySession(session, adminToken) ? csrfTokenForSession(session, adminToken) : undefined;
}

function csrfTokenForSession(session: string, adminToken: string): string {
  return crypto.createHmac("sha256", adminToken).update(`csrf:${session}`).digest("base64url");
}

function sessionCookie(req: Request): string | undefined {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === "string" ? value : undefined;
}

function signSession(adminToken: string): string {
  const issuedAt = Date.now().toString(36);
  const signature = crypto.createHmac("sha256", adminToken).update(issuedAt).digest("base64url");
  return `${issuedAt}.${signature}`;
}

function verifySession(value: string, adminToken: string): boolean {
  const [issuedAt, signature] = value.split(".");
  if (!issuedAt || !signature) return false;
  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > SESSION_MAX_AGE_MS) return false;
  const expected = crypto.createHmac("sha256", adminToken).update(issuedAt).digest("base64url");
  return safeEqual(signature, expected);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePeerCreate(body: Record<string, unknown>): PeerCreateInput {
  const generateKeys = body.generate_keys === undefined ? undefined : body.generate_keys === "true" || body.generate_keys === true;
  const input: PeerCreateInput = {
    name: field(body.name),
    public_key: optionalField(body.public_key),
    generate_keys: generateKeys,
    allowed_ips: csv(body.allowed_ips),
    dns_servers: csv(body.dns_servers),
    expires_at: optionalField(body.expires_at)
  };

  Object.keys(input).forEach((key) => {
    const value = input[key as keyof PeerCreateInput];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete input[key as keyof PeerCreateInput];
    }
  });

  return input;
}

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalField(value: unknown): string | undefined {
  const parsed = field(value);
  return parsed || undefined;
}

function csv(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function publicError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Request failed.";
}

function isRateLimited(key: string): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  const existing = loginFailures.get(key);
  if (!existing || now > existing.resetAt) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  existing.count += 1;
}

function clearFailedLogins(key: string): void {
  loginFailures.delete(key);
}

function safeFilename(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "kintunnel-peer";
}

import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import QRCode from "qrcode";
import type { AdminConfig } from "./config";
import { HttpEngineClient, type EngineClient } from "./engine-client";
import { dashboardPage, loginPage, newPeerPage, peerDetailPage } from "./html";
import type { PeerCreateInput } from "./types";

const SESSION_COOKIE = "kintunnel_admin";

export interface AppOptions {
  config: AdminConfig;
  engine?: EngineClient;
}

export function createApp({ config, engine = new HttpEngineClient(config.engineUrl) }: AppOptions) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(securityHeaders);

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
    const submittedToken = typeof req.body.token === "string" ? req.body.token : "";
    if (!safeEqual(submittedToken, config.adminToken)) {
      res.status(401).send(loginPage("Invalid admin token."));
      return;
    }

    res.cookie(SESSION_COOKIE, signToken(config.adminToken), {
      httpOnly: true,
      sameSite: "strict",
      secure: config.env === "production",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000
    });
    res.redirect("/");
  });

  app.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect("/login");
  });

  app.use(requireAuth(config.adminToken));

  app.get("/", async (_req, res) => {
    try {
      const [status, peers] = await Promise.all([engine.status(), engine.listPeers()]);
      res.send(dashboardPage(status, peers));
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false, message: publicError(error) }, [], undefined, publicError(error)));
    }
  });

  app.get("/peers/new", (_req, res) => {
    res.send(newPeerPage());
  });

  app.post("/peers", async (req, res) => {
    const input = parsePeerCreate(req.body);
    if (!input.name) {
      res.status(400).send(newPeerPage("Peer name is required."));
      return;
    }

    try {
      const peer = await engine.createPeer(input);
      res.redirect(`/peers/${encodeURIComponent(peer.id)}`);
    } catch (error) {
      res.status(502).send(newPeerPage(publicError(error)));
    }
  });

  app.get("/peers/:id", async (req, res) => {
    try {
      const peer = await engine.getPeer(req.params.id);
      let configText = "";
      let qrDataUrl = "";

      try {
        configText = await engine.getPeerConfig(req.params.id);
        qrDataUrl = configText ? await QRCode.toDataURL(configText, { errorCorrectionLevel: "M", margin: 1, width: 220 }) : "";
      } catch {
        // Peer metadata is still useful when the engine refuses config export.
      }

      res.send(peerDetailPage(peer, configText, qrDataUrl));
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], undefined, publicError(error)));
    }
  });

  app.post("/peers/:id/revoke", async (req, res) => {
    try {
      await engine.revokePeer(req.params.id);
      res.redirect(`/peers/${encodeURIComponent(req.params.id)}`);
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], undefined, publicError(error)));
    }
  });

  app.post("/peers/:id/delete", async (req, res) => {
    try {
      await engine.deletePeer(req.params.id);
      res.redirect("/");
    } catch (error) {
      res.status(502).send(dashboardPage({ ready: false }, [], undefined, publicError(error)));
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

function requireAuth(adminToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isAuthenticated(req, adminToken)) {
      next();
      return;
    }
    res.redirect("/login");
  };
}

function isAuthenticated(req: Request, adminToken: string): boolean {
  const header = req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const directToken = req.header("x-admin-token");
  const cookieToken = typeof req.cookies?.[SESSION_COOKIE] === "string" ? unsignToken(req.cookies[SESSION_COOKIE]) : undefined;
  return [bearer, directToken, cookieToken].some((token) => typeof token === "string" && safeEqual(token, adminToken));
}

function signToken(token: string): string {
  return Buffer.from(token, "utf8").toString("base64url");
}

function unsignToken(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
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
  const input: PeerCreateInput = {
    name: field(body.name),
    public_key: optionalField(body.public_key),
    generate_keys: body.generate_keys === "true" || body.generate_keys === true,
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

#!/usr/bin/env node
import http, { IncomingMessage, ServerResponse } from "http";
import { randomBytes, randomUUID } from "crypto";
import WebSocket = require("ws");

type Role = "boss" | "employee";

type ClientAuthMessage = {
  type: "auth";
  role: Role;
  authkey?: string;
  identity?: {
    id: string;
    key: string;
  };
  meta?: Record<string, unknown>;
};

type ClientRouteMessage = {
  type: "message";
  to: string | string[];
  payload: unknown;
  msg_id?: string;
};

type ClientPingMessage = {
  type: "ping";
};

type ClientMessage = ClientAuthMessage | ClientRouteMessage | ClientPingMessage;

type IdentityRecord = {
  id: string;
  role: Role;
  key: string;
  banned: boolean;
  createdAt: number;
  lastSeen: number;
  meta?: Record<string, unknown>;
  socket?: WebSocket;
};

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? 8787;
const HOST = args.host ?? "0.0.0.0";
const WS_PATH = args.wsPath ?? "/ws";
const AUTH_KEY = args.authkey ?? process.env.MIMICLAW_AUTHKEY;

if (!AUTH_KEY) {
  console.error("Missing auth key. Use --authkey=<value> or env MIMICLAW_AUTHKEY.");
  process.exit(1);
}

const identities = new Map<string, IdentityRecord>();
const socketToIdentity = new Map<WebSocket, string>();

const server = http.createServer(handleHttp);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  sendJson(ws, {
    type: "hello",
    message: "Please authenticate",
    schema: {
      type: "auth",
      role: "boss|employee",
      authkey: "required for boss",
      identity: { id: "optional reconnect id", key: "optional reconnect key" },
    },
  });

  let authed = false;
  const authTimer = setTimeout(() => {
    if (!authed) {
      safeClose(ws, 4001, "Auth timeout");
    }
  }, 15000);

  ws.on("message", (raw) => {
    const msg = parseClientMessage(raw.toString());
    if (!msg) {
      sendError(ws, "invalid_json", "Message must be valid JSON.");
      return;
    }

    if (!authed) {
      if (msg.type !== "auth") {
        sendError(ws, "auth_required", "First message must be auth.");
        return;
      }
      const result = authenticateSocket(ws, msg);
      if (result.ok === false) {
        sendError(ws, result.code, result.message);
        safeClose(ws, 4003, result.message);
        return;
      }

      authed = true;
      clearTimeout(authTimer);
      sendJson(ws, {
        type: "auth_ok",
        id: result.identity.id,
        key: result.identity.key,
        role: result.identity.role,
        reconnected: result.reconnected,
        timestamp: Date.now(),
      });
      return;
    }

    const senderId = socketToIdentity.get(ws);
    if (!senderId) {
      sendError(ws, "unknown_identity", "No identity found for socket.");
      safeClose(ws, 1011, "Internal identity error");
      return;
    }

    const sender = identities.get(senderId);
    if (!sender) {
      sendError(ws, "unknown_identity", "Identity does not exist.");
      safeClose(ws, 1011, "Identity missing");
      return;
    }

    sender.lastSeen = Date.now();

    if (msg.type === "ping") {
      sendJson(ws, { type: "pong", timestamp: Date.now() });
      return;
    }

    if (msg.type !== "message") {
      sendError(ws, "unsupported_type", "Unsupported message type.");
      return;
    }

    routeMessage(sender, msg, ws);
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    const identityId = socketToIdentity.get(ws);
    if (!identityId) {
      return;
    }
    socketToIdentity.delete(ws);
    const identity = identities.get(identityId);
    if (!identity) {
      return;
    }
    if (identity.socket === ws) {
      identity.socket = undefined;
      identity.lastSeen = Date.now();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify(
      {
        service: "mimiclaw-websocket",
        status: "listening",
        host: HOST,
        port: PORT,
        ws_path: WS_PATH,
      },
      null,
      2,
    ),
  );
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const ws of socketToIdentity.keys()) {
    safeClose(ws, 1001, "Server shutting down");
  }
  wss.close();
  server.close(() => process.exit(0));
}

function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/health" && method === "GET") {
    return writeJson(res, 200, {
      ok: true,
      service: "mimiclaw-websocket",
      now: Date.now(),
      active_connections: socketToIdentity.size,
    });
  }

  if (!isAuthorizedHttp(req, url)) {
    return writeJson(res, 401, {
      error: "unauthorized",
      message: "Provide auth key via x-auth-key header or authkey query param.",
    });
  }

  if (path === "/employees" && method === "GET") {
    return writeJson(res, 200, {
      employees: listEmployees(),
    });
  }

  const banMatch = path.match(/^\/employees\/([^/]+)\/ban$/);
  if (banMatch && (method === "POST" || method === "PUT")) {
    const employeeId = decodeURIComponent(banMatch[1]);
    return readJsonBody(req)
      .then((body) => {
        const banned =
          typeof body?.banned === "boolean" ? body.banned : true;
        const updated = setEmployeeBan(employeeId, banned);
        if (updated.ok === false) {
          return writeJson(res, 404, { error: "not_found", message: updated.message });
        }
        return writeJson(res, 200, {
          id: updated.record.id,
          role: updated.record.role,
          banned: updated.record.banned,
          online: isOnline(updated.record),
        });
      })
      .catch(() =>
        writeJson(res, 400, { error: "bad_request", message: "Body must be valid JSON." }),
      );
  }

  if (banMatch && method === "DELETE") {
    const employeeId = decodeURIComponent(banMatch[1]);
    const updated = setEmployeeBan(employeeId, false);
    if (updated.ok === false) {
      return writeJson(res, 404, { error: "not_found", message: updated.message });
    }
    return writeJson(res, 200, {
      id: updated.record.id,
      role: updated.record.role,
      banned: updated.record.banned,
      online: isOnline(updated.record),
    });
  }

  return writeJson(res, 404, { error: "not_found" });
}

function listEmployees() {
  const rows: Array<Record<string, unknown>> = [];
  for (const identity of identities.values()) {
    if (identity.role !== "employee") {
      continue;
    }
    rows.push({
      id: identity.id,
      role: identity.role,
      online: isOnline(identity),
      banned: identity.banned,
      created_at: identity.createdAt,
      last_seen: identity.lastSeen,
      meta: identity.meta ?? null,
    });
  }
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return rows;
}

function isAuthorizedHttp(req: IncomingMessage, url: URL) {
  const header = req.headers["x-auth-key"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = url.searchParams.get("authkey");
  return fromHeader === AUTH_KEY || fromQuery === AUTH_KEY;
}

function authenticateSocket(
  ws: WebSocket,
  msg: ClientAuthMessage,
): { ok: true; identity: IdentityRecord; reconnected: boolean } | { ok: false; code: string; message: string } {
  if (msg.role !== "boss" && msg.role !== "employee") {
    return { ok: false, code: "invalid_role", message: "role must be boss or employee." };
  }

  if (msg.role === "boss" && msg.authkey !== AUTH_KEY) {
    return { ok: false, code: "invalid_authkey", message: "Boss auth key invalid." };
  }

  if (msg.identity?.id || msg.identity?.key) {
    if (!msg.identity?.id || !msg.identity?.key) {
      return {
        ok: false,
        code: "invalid_identity",
        message: "Both identity.id and identity.key are required for reconnect.",
      };
    }
    const existing = identities.get(msg.identity.id);
    if (!existing) {
      return { ok: false, code: "identity_not_found", message: "Identity id not found." };
    }
    if (existing.key !== msg.identity.key) {
      return { ok: false, code: "invalid_identity_key", message: "Identity key mismatch." };
    }
    if (existing.role !== msg.role) {
      return { ok: false, code: "role_mismatch", message: "Role mismatch with identity." };
    }
    if (existing.banned && existing.role === "employee") {
      return { ok: false, code: "banned", message: "Employee is banned." };
    }

    if (existing.socket && existing.socket !== ws && existing.socket.readyState === WebSocket.OPEN) {
      safeClose(existing.socket, 4000, "Reconnected from another session");
    }
    existing.socket = ws;
    existing.lastSeen = Date.now();
    existing.meta = msg.meta;
    socketToIdentity.set(ws, existing.id);
    return { ok: true, identity: existing, reconnected: true };
  }

  if (msg.role === "employee" && msg.authkey && msg.authkey !== AUTH_KEY) {
    return { ok: false, code: "invalid_authkey", message: "Provided auth key is invalid." };
  }

  const now = Date.now();
  const newIdentity: IdentityRecord = {
    id: `${msg.role}-${randomUUID()}`,
    role: msg.role,
    key: randomBytes(24).toString("hex"),
    banned: false,
    createdAt: now,
    lastSeen: now,
    meta: msg.meta,
    socket: ws,
  };
  identities.set(newIdentity.id, newIdentity);
  socketToIdentity.set(ws, newIdentity.id);
  return { ok: true, identity: newIdentity, reconnected: false };
}

function routeMessage(sender: IdentityRecord, msg: ClientRouteMessage, ws: WebSocket) {
  const msgId = msg.msg_id ?? randomUUID();
  const targets = normalizeTargets(msg.to);
  if (targets.length === 0) {
    sendError(ws, "invalid_to", "Field 'to' must contain at least one target.");
    return;
  }

  const delivered: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const finalTargets = expandTargets(targets, sender.id);

  for (const targetId of finalTargets) {
    const target = identities.get(targetId);
    if (!target) {
      failed.push({ id: targetId, reason: "target_not_found" });
      continue;
    }
    if (target.banned && target.role === "employee") {
      failed.push({ id: targetId, reason: "target_banned" });
      continue;
    }
    if (!target.socket || target.socket.readyState !== WebSocket.OPEN) {
      failed.push({ id: targetId, reason: "target_offline" });
      continue;
    }

    sendJson(target.socket, {
      type: "message",
      msg_id: msgId,
      from_id: sender.id,
      from_role: sender.role,
      to: targetId,
      payload: msg.payload,
      timestamp: Date.now(),
    });
    delivered.push(targetId);
  }

  sendJson(ws, {
    type: "delivery_ack",
    msg_id: msgId,
    delivered,
    failed,
    timestamp: Date.now(),
  });
}

function expandTargets(targets: string[], senderId: string) {
  if (targets.includes("*") || targets.includes("all")) {
    const all = Array.from(identities.values())
      .filter((v) => v.id !== senderId)
      .map((v) => v.id);
    return Array.from(new Set(all));
  }
  return Array.from(new Set(targets));
}

function normalizeTargets(to: string | string[]) {
  if (Array.isArray(to)) {
    return to.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof to === "string") {
    const single = to.trim();
    return single ? [single] : [];
  }
  return [];
}

function setEmployeeBan(
  id: string,
  banned: boolean,
): { ok: true; record: IdentityRecord } | { ok: false; message: string } {
  const record = identities.get(id);
  if (!record) {
    return { ok: false, message: "Employee not found." };
  }
  if (record.role !== "employee") {
    return { ok: false, message: "Target is not an employee." };
  }
  record.banned = banned;
  record.lastSeen = Date.now();
  if (banned && record.socket && record.socket.readyState === WebSocket.OPEN) {
    sendJson(record.socket, {
      type: "system",
      event: "banned",
      by: "boss-http",
      timestamp: Date.now(),
    });
    safeClose(record.socket, 4008, "Banned by boss");
  }
  return { ok: true, record };
}

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body);
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function sendError(ws: WebSocket, code: string, message: string) {
  sendJson(ws, {
    type: "error",
    code,
    message,
    timestamp: Date.now(),
  });
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    return;
  }
  ws.close(code, reason);
}

function isOnline(record: IdentityRecord) {
  return !!record.socket && record.socket.readyState === WebSocket.OPEN;
}

function parseArgs(argv: string[]) {
  const out: {
    port?: number;
    host?: string;
    authkey?: string;
    wsPath?: string;
  } = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current.startsWith("--port=")) {
      out.port = parsePort(current.slice("--port=".length));
      continue;
    }
    if (current === "--port") {
      out.port = parsePort(argv[i + 1]);
      i += 1;
      continue;
    }
    if (current.startsWith("--host=")) {
      out.host = current.slice("--host=".length);
      continue;
    }
    if (current === "--host") {
      out.host = argv[i + 1];
      i += 1;
      continue;
    }
    if (current.startsWith("--authkey=")) {
      out.authkey = current.slice("--authkey=".length);
      continue;
    }
    if (current === "--authkey") {
      out.authkey = argv[i + 1];
      i += 1;
      continue;
    }
    if (current.startsWith("--ws-path=")) {
      out.wsPath = normalizeWsPath(current.slice("--ws-path=".length));
      continue;
    }
    if (current === "--ws-path") {
      out.wsPath = normalizeWsPath(argv[i + 1]);
      i += 1;
      continue;
    }
    if (!current.startsWith("-")) {
      positional.push(current);
    }
  }

  if (out.port === undefined && positional[0]) {
    out.port = parsePort(positional[0]);
  }
  if (!out.authkey && positional[1]) {
    out.authkey = positional[1];
  }

  return out;
}

function parsePort(value: string | undefined) {
  const fallback = 8787;
  if (!value) {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 65535) {
    return fallback;
  }
  return Math.floor(num);
}

function normalizeWsPath(value: string | undefined) {
  if (!value) {
    return "/ws";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

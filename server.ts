#!/usr/bin/env node
import http, { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import WebSocket = require("ws");
import Nedb from "@seald-io/nedb";

type Role = "boss" | "employee";
type ConnectionStatus = "online" | "offline" | "banned";

type ClientAuthMessage = {
  type: "auth";
  role: Role;
  authkey?: string;
  name?: string;
  tags?: string[];
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

type ClientHealthReportMessage = {
  type: "health_report";
  valid: boolean;
  details?: Record<string, unknown>;
};

type ClientMessage =
  | ClientAuthMessage
  | ClientRouteMessage
  | ClientPingMessage
  | ClientHealthReportMessage;

type IdentityRecord = {
  id: string;
  role: Role;
  key: string;
  banned: boolean;
  createdAt: number;
  lastSeen: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastHeartbeatAt?: number;
  lastSelfReportAt?: number;
  selfReportValid?: boolean;
  name?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  socket?: WebSocket;
};

type IdentityDoc = {
  _id: string;
  id: string;
  role: Role;
  key: string;
  banned: boolean;
  createdAt: number;
  lastSeen: number;
  lastHeartbeatAt?: number;
  lastSelfReportAt?: number;
  selfReportValid?: boolean;
  name?: string;
  tags?: string[];
  status: ConnectionStatus;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  updatedAt: number;
  meta?: Record<string, unknown>;
};

type ConnectionEventDoc = {
  _id: string;
  identityId: string;
  role: Role;
  event: "auth_ok" | "reconnect" | "disconnect" | "ban" | "unban" | "auth_fail";
  reason?: string;
  timestamp: number;
  online: boolean;
  meta?: Record<string, unknown>;
};

type MessageLogDoc = {
  _id: string;
  msgId: string;
  fromId: string;
  fromRole: Role;
  requestedTargets: string[];
  resolvedTargets: string[];
  delivered: string[];
  failed: Array<{ id: string; reason: string }>;
  payload: unknown;
  timestamp: number;
};

type NodeSnapshot = {
  id: string;
  role: Role | "unknown";
  name: string | null;
  tags: string[];
};

type AdminCommunicationRow = {
  msg_id: string;
  timestamp: number;
  direction: "boss_to_employee" | "employee_to_boss";
  boss: NodeSnapshot;
  employee: NodeSnapshot;
  from: NodeSnapshot;
  to: NodeSnapshot;
  delivery: {
    status: "delivered" | "failed" | "unknown";
    reason: string | null;
  };
  payload: unknown;
};

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? 8787;
const HOST = args.host ?? "0.0.0.0";
const WS_PATH = args.wsPath ?? "/ws";
const AUTH_KEY = args.authkey ?? process.env.MIMICLAW_AUTHKEY;
const RELAY_HOME = resolveRelayHome(args.dataDir ?? process.env.MIMICLAW_RELAY_HOME);
const ADMIN_DIST_DIR = resolveAdminDistDir(args.adminDist ?? process.env.MIMICLAW_ADMIN_DIST);
const DB_FILES = {
  identities: path.join(RELAY_HOME, "identities.db"),
  connections: path.join(RELAY_HOME, "connections.db"),
  messages: path.join(RELAY_HOME, "messages.db"),
};
const HEARTBEAT_STALE_MS = 60_000;
const SELF_REPORT_STALE_MS = 180_000;

if (!AUTH_KEY) {
  console.error("Missing auth key. Use --authkey=<value> or env MIMICLAW_AUTHKEY.");
  process.exit(1);
}

const identities = new Map<string, IdentityRecord>();
const socketToIdentity = new Map<WebSocket, string>();
let identitiesDb: Nedb<IdentityDoc>;
let connectionsDb: Nedb<ConnectionEventDoc>;
let messagesDb: Nedb<MessageLogDoc>;

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
      name: "required when role=employee and first-time register",
      tags: "required string[] when role=employee and first-time register",
      health_report: { type: "health_report", valid: "boolean", details: "optional object" },
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
        fireAndForget(
          persistConnectionEvent({
            identityId: msg.identity?.id ?? "unknown",
            role: msg.role,
            event: "auth_fail",
            reason: result.message,
            online: false,
            meta: msg.meta,
          }),
          "persist auth_fail event",
        );
        sendError(ws, result.code, result.message);
        safeClose(ws, 4003, result.message);
        return;
      }

      authed = true;
      clearTimeout(authTimer);
      result.identity.lastConnectedAt = Date.now();
      fireAndForget(
        persistIdentity(result.identity, {
          status: computeStatus(result.identity),
          lastConnectedAt: result.identity.lastConnectedAt,
        }),
        "persist identity after auth",
      );
      fireAndForget(
        persistConnectionEvent({
          identityId: result.identity.id,
          role: result.identity.role,
          event: result.reconnected ? "reconnect" : "auth_ok",
          online: true,
          meta: result.identity.meta,
        }),
        "persist auth event",
      );
      sendJson(ws, {
        type: "auth_ok",
        id: result.identity.id,
        key: result.identity.key,
        role: result.identity.role,
        name: result.identity.name ?? null,
        tags: result.identity.tags ?? [],
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
      sender.lastHeartbeatAt = Date.now();
      fireAndForget(
        persistIdentity(sender, { status: computeStatus(sender) }),
        "persist sender ping",
      );
      sendJson(ws, { type: "pong", timestamp: Date.now() });
      return;
    }

    if (msg.type === "health_report") {
      if (typeof msg.valid !== "boolean") {
        sendError(ws, "invalid_health_report", "Field 'valid' must be boolean.");
        return;
      }
      sender.selfReportValid = msg.valid;
      sender.lastSelfReportAt = Date.now();
      fireAndForget(
        persistIdentity(sender, { status: computeStatus(sender) }),
        "persist health_report",
      );
      sendJson(ws, {
        type: "health_report_ack",
        id: sender.id,
        valid: sender.selfReportValid,
        timestamp: Date.now(),
      });
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
      identity.lastDisconnectedAt = Date.now();
      fireAndForget(
        persistIdentity(identity, {
          status: computeStatus(identity),
          lastDisconnectedAt: identity.lastDisconnectedAt,
        }),
        "persist identity on disconnect",
      );
      fireAndForget(
        persistConnectionEvent({
          identityId: identity.id,
          role: identity.role,
          event: "disconnect",
          online: false,
        }),
        "persist disconnect event",
      );
    }
  });
});

void bootstrap();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function bootstrap() {
  try {
    ensureRelayHome(RELAY_HOME);
    await initDatastores();
    await restoreIdentitiesFromDisk();

    server.listen(PORT, HOST, () => {
      console.log(
        JSON.stringify(
          {
            service: "mimiclaw-websocket",
            status: "listening",
            host: HOST,
            port: PORT,
            ws_path: WS_PATH,
            relay_home: RELAY_HOME,
            admin_dist: ADMIN_DIST_DIR,
          },
          null,
          2,
        ),
      );
    });
  } catch (err) {
    console.error("Failed to bootstrap datastore:", err);
    process.exit(1);
  }
}

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
  const requestPath = url.pathname;
  if (isApiRequestPath(requestPath)) {
    const apiPath = stripApiPrefix(requestPath);
    return handleApiHttp(req, res, method, url, apiPath);
  }
  return serveAdminStatic(requestPath, res);
}

function handleApiHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  apiPath: string,
) {
  if (apiPath === "/health" && method === "GET") {
    return writeJson(res, 200, {
      ok: true,
      service: "mimiclaw-websocket",
      now: Date.now(),
      active_connections: socketToIdentity.size,
      relay_home: RELAY_HOME,
      admin_dist: ADMIN_DIST_DIR,
    });
  }

  if (!isAuthorizedHttp(req, url)) {
    return writeJson(res, 401, {
      error: "unauthorized",
      message: "Provide auth key via x-auth-key header or authkey query param.",
    });
  }

  if (apiPath === "/employees" && method === "GET") {
    return writeJson(res, 200, {
      employees: listEmployees(),
    });
  }

  if (apiPath === "/connections" && method === "GET") {
    return writeJson(res, 200, {
      connections: listConnections(),
    });
  }

  if (apiPath === "/admin/workforce" && method === "GET") {
    return writeJson(res, 200, buildAdminWorkforceResponse(url.searchParams));
  }

  if (apiPath === "/admin/communications" && method === "GET") {
    return writeJson(res, 200, buildAdminCommunicationsResponse(url.searchParams));
  }

  const banMatch = apiPath.match(/^\/employees\/([^/]+)\/ban$/);
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
          name: updated.record.name ?? null,
          tags: updated.record.tags ?? [],
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
      name: updated.record.name ?? null,
      tags: updated.record.tags ?? [],
      banned: updated.record.banned,
      online: isOnline(updated.record),
    });
  }

  return writeJson(res, 404, { error: "not_found" });
}

function serveAdminStatic(requestPath: string, res: ServerResponse) {
  if (!fs.existsSync(ADMIN_DIST_DIR)) {
    return writeJson(res, 404, {
      error: "admin_not_built",
      message: `Admin dist not found at ${ADMIN_DIST_DIR}. Copy admin dist into this path.`,
    });
  }

  const normalized = requestPath.replace(/^\/+/, "");
  const resolved = path.resolve(ADMIN_DIST_DIR, normalized || "index.html");
  if (!isPathInside(ADMIN_DIST_DIR, resolved)) {
    return writeJson(res, 403, { error: "forbidden" });
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return streamFile(resolved, res);
  }

  const fallback = path.join(ADMIN_DIST_DIR, "index.html");
  if (fs.existsSync(fallback)) {
    return streamFile(fallback, res);
  }

  return writeJson(res, 404, { error: "not_found" });
}

function streamFile(filePath: string, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", getMimeType(filePath));
  fs.createReadStream(filePath).pipe(res);
}

function getMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".ico") {
    return "image/x-icon";
  }
  return "application/octet-stream";
}

function isPathInside(root: string, target: string) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}${path.sep}`);
}

function isApiRequestPath(requestPath: string) {
  if (requestPath === "/api" || requestPath.startsWith("/api/")) {
    return true;
  }
  if (requestPath === "/health") {
    return true;
  }
  if (requestPath === "/employees" || requestPath === "/connections") {
    return true;
  }
  if (requestPath === "/admin/workforce" || requestPath === "/admin/communications") {
    return true;
  }
  return /^\/employees\/[^/]+\/ban$/.test(requestPath);
}

function stripApiPrefix(requestPath: string) {
  if (requestPath === "/api") {
    return "/";
  }
  if (requestPath.startsWith("/api/")) {
    const stripped = requestPath.slice(4);
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  return requestPath;
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
      name: identity.name ?? null,
      tags: identity.tags ?? [],
      online: isOnline(identity),
      status: computeStatus(identity),
      banned: identity.banned,
      created_at: identity.createdAt,
      last_seen: identity.lastSeen,
      meta: identity.meta ?? null,
    });
  }
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return rows;
}

function listConnections() {
  const rows: Array<Record<string, unknown>> = [];
  for (const identity of identities.values()) {
    rows.push({
      id: identity.id,
      role: identity.role,
      name: identity.name ?? null,
      tags: identity.tags ?? [],
      online: isOnline(identity),
      status: computeStatus(identity),
      banned: identity.banned,
      created_at: identity.createdAt,
      last_seen: identity.lastSeen,
      meta: identity.meta ?? null,
    });
  }
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return rows;
}

function buildAdminWorkforceResponse(params: URLSearchParams) {
  const tagFilter = params.get("tag")?.trim();
  const now = Date.now();
  const bosses: Array<Record<string, unknown>> = [];
  const employees: Array<Record<string, unknown>> = [];
  const employeesByTag = new Map<string, Array<Record<string, unknown>>>();
  const healthCounters = { healthy: 0, degraded: 0, unhealthy: 0 };
  let onlineCount = 0;
  let offlineCount = 0;
  let bannedCount = 0;

  const sorted = Array.from(identities.values()).sort((a, b) => a.id.localeCompare(b.id));
  for (const identity of sorted) {
    const health = computeHealthDetails(identity, now);
    if (health.overall === "healthy") {
      healthCounters.healthy += 1;
    } else if (health.overall === "degraded") {
      healthCounters.degraded += 1;
    } else {
      healthCounters.unhealthy += 1;
    }

    if (isOnline(identity)) {
      onlineCount += 1;
    } else {
      offlineCount += 1;
    }
    if (identity.banned) {
      bannedCount += 1;
    }

    const node = {
      id: identity.id,
      role: identity.role,
      name: identity.name ?? null,
      tags: identity.tags ?? [],
      status: computeStatus(identity),
      online: isOnline(identity),
      banned: identity.banned,
      created_at: identity.createdAt,
      last_seen: identity.lastSeen,
      health,
      meta: identity.meta ?? null,
    };

    if (identity.role === "boss") {
      bosses.push(node);
      continue;
    }

    if (tagFilter) {
      const tags = identity.tags ?? [];
      if (!tags.includes(tagFilter)) {
        continue;
      }
    }
    employees.push(node);

    const tags = identity.tags ?? [];
    for (const tag of tags) {
      if (!employeesByTag.has(tag)) {
        employeesByTag.set(tag, []);
      }
      employeesByTag.get(tag)?.push(node);
    }
  }

  const tags: Record<string, unknown> = {};
  for (const [tag, items] of employeesByTag.entries()) {
    tags[tag] = {
      count: items.length,
      employee_ids: items.map((item) => item.id),
      employees: items,
    };
  }

  return {
    summary: {
      total_nodes: identities.size,
      boss_count: bosses.length,
      employee_count: employees.length,
      online_count: onlineCount,
      offline_count: offlineCount,
      banned_count: bannedCount,
      health: healthCounters,
      filtered_by_tag: tagFilter ?? null,
    },
    bosses,
    employees,
    employees_by_tag: tags,
    timestamp: now,
  };
}

function buildAdminCommunicationsResponse(params: URLSearchParams) {
  const now = Date.now();
  const bossIdFilter = params.get("boss_id")?.trim();
  const employeeIdFilter = params.get("employee_id")?.trim();
  const tagFilter = params.get("tag")?.trim();
  const since = parseOptionalInt(params.get("since"));
  const until = parseOptionalInt(params.get("until"));
  const limit = parseBoundedInt(params.get("limit"), 50, 1, 500);
  const offset = parseBoundedInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const messageDocs = messagesDb
    .getAllData<MessageLogDoc>()
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);

  const rows: Array<Record<string, unknown>> = [];
  for (const doc of messageDocs) {
    if (since !== null && doc.timestamp < since) {
      continue;
    }
    if (until !== null && doc.timestamp > until) {
      continue;
    }

    const targets = Array.from(new Set([
      ...doc.resolvedTargets,
      ...doc.delivered,
      ...doc.failed.map((item) => item.id),
    ]));
    for (const toId of targets) {
      const edge = buildBossEmployeeEdge(doc, toId);
      if (!edge) {
        continue;
      }

      const edgeBossId = edge.boss.id;
      const edgeEmployeeId = edge.employee.id;
      if (bossIdFilter && edgeBossId !== bossIdFilter) {
        continue;
      }
      if (employeeIdFilter && edgeEmployeeId !== employeeIdFilter) {
        continue;
      }
      if (tagFilter) {
        const tags = edge.employee.tags ?? [];
        if (!tags.includes(tagFilter)) {
          continue;
        }
      }

      rows.push(edge);
    }
  }

  const total = rows.length;
  const paged = rows.slice(offset, offset + limit);
  return {
    total,
    offset,
    limit,
    filters: {
      boss_id: bossIdFilter ?? null,
      employee_id: employeeIdFilter ?? null,
      tag: tagFilter ?? null,
      since,
      until,
    },
    rows: paged,
    timestamp: now,
  };
}

function buildBossEmployeeEdge(doc: MessageLogDoc, toId: string): AdminCommunicationRow | null {
  const fromIdentity = identities.get(doc.fromId);
  const toIdentity = identities.get(toId);
  const fromRole = fromIdentity?.role ?? inferRoleFromId(doc.fromId);
  const toRole = toIdentity?.role ?? inferRoleFromId(toId);

  const isBossToEmployee = fromRole === "boss" && toRole === "employee";
  const isEmployeeToBoss = fromRole === "employee" && toRole === "boss";
  if (!isBossToEmployee && !isEmployeeToBoss) {
    return null;
  }

  const failed = doc.failed.find((item) => item.id === toId);
  let delivery: AdminCommunicationRow["delivery"];
  if (failed) {
    delivery = { status: "failed", reason: failed.reason };
  } else if (doc.delivered.includes(toId)) {
    delivery = { status: "delivered", reason: null };
  } else {
    delivery = { status: "unknown", reason: null };
  }

  const boss = isBossToEmployee
    ? toNodeSnapshot(doc.fromId, "boss", fromIdentity)
    : toNodeSnapshot(toId, "boss", toIdentity);
  const employee = isBossToEmployee
    ? toNodeSnapshot(toId, "employee", toIdentity)
    : toNodeSnapshot(doc.fromId, "employee", fromIdentity);

  return {
    msg_id: doc.msgId,
    timestamp: doc.timestamp,
    direction: isBossToEmployee ? "boss_to_employee" : "employee_to_boss",
    boss,
    employee,
    from: toNodeSnapshot(doc.fromId, fromRole, fromIdentity),
    to: toNodeSnapshot(toId, toRole, toIdentity),
    delivery,
    payload: doc.payload,
  };
}

function toNodeSnapshot(
  id: string,
  role: Role | "unknown",
  identity?: IdentityRecord,
): NodeSnapshot {
  return {
    id,
    role,
    name: identity?.name ?? null,
    tags: identity?.tags ?? [],
  };
}

function inferRoleFromId(id: string): Role | "unknown" {
  if (id.startsWith("boss-")) {
    return "boss";
  }
  if (id.startsWith("employee-")) {
    return "employee";
  }
  return "unknown";
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

  if (msg.role === "employee" && msg.authkey && msg.authkey !== AUTH_KEY) {
    return { ok: false, code: "invalid_authkey", message: "Provided auth key is invalid." };
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
    if (msg.meta) {
      existing.meta = msg.meta;
    }
    if (existing.role === "employee" && (msg.name !== undefined || msg.tags !== undefined)) {
      const profile = validateEmployeeProfile(msg, false);
      if (profile.ok === false) {
        return { ok: false, code: profile.code, message: profile.message };
      }
      existing.name = profile.name;
      existing.tags = profile.tags;
    }
    socketToIdentity.set(ws, existing.id);
    return { ok: true, identity: existing, reconnected: true };
  }

  let employeeName: string | undefined;
  let employeeTags: string[] | undefined;
  if (msg.role === "employee") {
    const profile = validateEmployeeProfile(msg, true);
    if (profile.ok === false) {
      return { ok: false, code: profile.code, message: profile.message };
    }
    employeeName = profile.name;
    employeeTags = profile.tags;
  }

  const now = Date.now();
  const newIdentity: IdentityRecord = {
    id: `${msg.role}-${randomUUID()}`,
    role: msg.role,
    key: randomBytes(24).toString("hex"),
    banned: false,
    createdAt: now,
    lastSeen: now,
    name: employeeName,
    tags: employeeTags,
    meta: msg.meta,
    socket: ws,
  };
  identities.set(newIdentity.id, newIdentity);
  socketToIdentity.set(ws, newIdentity.id);
  return { ok: true, identity: newIdentity, reconnected: false };
}

function validateEmployeeProfile(
  msg: ClientAuthMessage,
  required: boolean,
): { ok: true; name: string; tags: string[] } | { ok: false; code: string; message: string } {
  if (!required && msg.name === undefined && msg.tags === undefined) {
    return { ok: true, name: "", tags: [] };
  }

  if (typeof msg.name !== "string" || !msg.name.trim()) {
    return {
      ok: false,
      code: "invalid_name",
      message: "Employee registration requires a non-empty name.",
    };
  }

  if (!Array.isArray(msg.tags)) {
    return {
      ok: false,
      code: "invalid_tags",
      message: "Employee registration requires tags as string array.",
    };
  }

  const tags = msg.tags
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) {
    return {
      ok: false,
      code: "invalid_tags",
      message: "Employee registration requires at least one tag.",
    };
  }

  return { ok: true, name: msg.name.trim(), tags: Array.from(new Set(tags)) };
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
  fireAndForget(
    persistIdentity(sender, { status: computeStatus(sender) }),
    "persist sender activity",
  );

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

  fireAndForget(
    persistMessageLog({
      msgId,
      fromId: sender.id,
      fromRole: sender.role,
      requestedTargets: targets,
      resolvedTargets: finalTargets,
      delivered,
      failed,
      payload: msg.payload,
    }),
    "persist message log",
  );
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
  fireAndForget(
    persistIdentity(record, {
      status: computeStatus(record),
    }),
    "persist identity on ban update",
  );
  fireAndForget(
    persistConnectionEvent({
      identityId: record.id,
      role: record.role,
      event: banned ? "ban" : "unban",
      online: isOnline(record),
      reason: "boss-http",
    }),
    "persist ban event",
  );
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

function computeStatus(record: IdentityRecord): ConnectionStatus {
  if (record.banned) {
    return "banned";
  }
  return isOnline(record) ? "online" : "offline";
}

function computeHealthDetails(record: IdentityRecord, now: number) {
  const status = computeStatus(record);
  const online = isOnline(record);
  const heartbeatAgeMs = typeof record.lastSeen === "number" ? Math.max(0, now - record.lastSeen) : null;
  const heartbeatStale = heartbeatAgeMs === null ? true : heartbeatAgeMs > HEARTBEAT_STALE_MS;
  const selfReportAgeMs =
    typeof record.lastSelfReportAt === "number" ? Math.max(0, now - record.lastSelfReportAt) : null;
  const selfReportStale = selfReportAgeMs !== null ? selfReportAgeMs > SELF_REPORT_STALE_MS : true;

  const reasons: string[] = [];
  let overall: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (record.banned) {
    overall = "unhealthy";
    reasons.push("banned");
  } else if (!online) {
    overall = "unhealthy";
    reasons.push("offline");
  } else {
    if (heartbeatStale) {
      overall = "degraded";
      reasons.push("heartbeat_stale");
    }
    if (record.selfReportValid === false) {
      overall = "degraded";
      reasons.push("self_report_invalid");
    } else if (record.selfReportValid === undefined) {
      overall = "degraded";
      reasons.push("self_report_missing");
    } else if (selfReportStale) {
      overall = "degraded";
      reasons.push("self_report_stale");
    }
  }

  return {
    overall,
    reasons,
    status,
    online,
    heartbeat: {
      last_seen_at: record.lastSeen,
      age_ms: heartbeatAgeMs,
      stale: heartbeatStale,
      stale_threshold_ms: HEARTBEAT_STALE_MS,
    },
    self_report: {
      valid: record.selfReportValid ?? null,
      last_report_at: record.lastSelfReportAt ?? null,
      age_ms: selfReportAgeMs,
      stale: selfReportStale,
      stale_threshold_ms: SELF_REPORT_STALE_MS,
    },
    connection: {
      last_connected_at: record.lastConnectedAt ?? null,
      last_disconnected_at: record.lastDisconnectedAt ?? null,
      websocket_open: online,
    },
  };
}

function ensureRelayHome(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function initDatastores() {
  identitiesDb = new Nedb<IdentityDoc>({
    filename: DB_FILES.identities,
    autoload: true,
    timestampData: false,
  });
  connectionsDb = new Nedb<ConnectionEventDoc>({
    filename: DB_FILES.connections,
    autoload: true,
    timestampData: false,
  });
  messagesDb = new Nedb<MessageLogDoc>({
    filename: DB_FILES.messages,
    autoload: true,
    timestampData: false,
  });

  await Promise.all([
    identitiesDb.loadDatabaseAsync(),
    connectionsDb.loadDatabaseAsync(),
    messagesDb.loadDatabaseAsync(),
  ]);

  await Promise.all([
    identitiesDb.ensureIndexAsync({ fieldName: "id", unique: true }),
    identitiesDb.ensureIndexAsync({ fieldName: "role" }),
    identitiesDb.ensureIndexAsync({ fieldName: "status" }),
    identitiesDb.ensureIndexAsync({ fieldName: "tags" }),
    connectionsDb.ensureIndexAsync({ fieldName: "identityId" }),
    connectionsDb.ensureIndexAsync({ fieldName: "timestamp" }),
    messagesDb.ensureIndexAsync({ fieldName: "msgId" }),
    messagesDb.ensureIndexAsync({ fieldName: "timestamp" }),
  ]);

  const now = Date.now();
  await identitiesDb.updateAsync(
    { banned: false, status: "online" },
    { $set: { status: "offline", lastDisconnectedAt: now, updatedAt: now } },
    { multi: true },
  );
}

async function restoreIdentitiesFromDisk() {
  const docs = identitiesDb.getAllData<IdentityDoc>();
  for (const doc of docs) {
    const id = doc.id || doc._id;
    if (!id || (doc.role !== "boss" && doc.role !== "employee") || typeof doc.key !== "string") {
      continue;
    }
    identities.set(id, {
      id,
      role: doc.role,
      key: doc.key,
      banned: !!doc.banned,
      createdAt: doc.createdAt ?? Date.now(),
      lastSeen: doc.lastSeen ?? Date.now(),
      lastConnectedAt: doc.lastConnectedAt,
      lastDisconnectedAt: doc.lastDisconnectedAt,
      lastHeartbeatAt: doc.lastHeartbeatAt,
      lastSelfReportAt: doc.lastSelfReportAt,
      selfReportValid: typeof doc.selfReportValid === "boolean" ? doc.selfReportValid : undefined,
      name: typeof doc.name === "string" ? doc.name : undefined,
      tags: Array.isArray(doc.tags) ? doc.tags.map((v) => String(v)).filter(Boolean) : undefined,
      meta: doc.meta,
    });
  }
}

async function persistIdentity(
  record: IdentityRecord,
  extra?: {
    status?: ConnectionStatus;
    lastConnectedAt?: number;
    lastDisconnectedAt?: number;
  },
) {
  const now = Date.now();
  const updatePayload: Partial<IdentityDoc> = {
    id: record.id,
    role: record.role,
    key: record.key,
    banned: record.banned,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
    lastConnectedAt: record.lastConnectedAt,
    lastDisconnectedAt: record.lastDisconnectedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastSelfReportAt: record.lastSelfReportAt,
    selfReportValid: record.selfReportValid,
    name: record.name,
    tags: record.tags,
    meta: record.meta,
    status: extra?.status ?? computeStatus(record),
    updatedAt: now,
  };
  if (extra?.lastConnectedAt !== undefined) {
    updatePayload.lastConnectedAt = extra.lastConnectedAt;
  }
  if (extra?.lastDisconnectedAt !== undefined) {
    updatePayload.lastDisconnectedAt = extra.lastDisconnectedAt;
  }

  await identitiesDb.updateAsync(
    { _id: record.id },
    { $set: updatePayload },
    { upsert: true },
  );
}

async function persistConnectionEvent(
  event: Omit<ConnectionEventDoc, "_id" | "timestamp"> & { timestamp?: number },
) {
  await connectionsDb.insertAsync({
    _id: randomUUID(),
    timestamp: event.timestamp ?? Date.now(),
    identityId: event.identityId,
    role: event.role,
    event: event.event,
    reason: event.reason,
    online: event.online,
    meta: event.meta,
  });
}

async function persistMessageLog(
  message: Omit<MessageLogDoc, "_id" | "timestamp"> & { timestamp?: number },
) {
  await messagesDb.insertAsync({
    _id: randomUUID(),
    msgId: message.msgId,
    fromId: message.fromId,
    fromRole: message.fromRole,
    requestedTargets: message.requestedTargets,
    resolvedTargets: message.resolvedTargets,
    delivered: message.delivered,
    failed: message.failed,
    payload: message.payload,
    timestamp: message.timestamp ?? Date.now(),
  });
}

function fireAndForget(task: Promise<unknown>, context: string) {
  void task.catch((err) => {
    console.error(`[persist] ${context}:`, err);
  });
}

function parseArgs(argv: string[]) {
  const out: {
    port?: number;
    host?: string;
    authkey?: string;
    wsPath?: string;
    dataDir?: string;
    adminDist?: string;
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
    if (current.startsWith("--data-dir=")) {
      out.dataDir = current.slice("--data-dir=".length);
      continue;
    }
    if (current === "--data-dir") {
      out.dataDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (current.startsWith("--admin-dist=")) {
      out.adminDist = current.slice("--admin-dist=".length);
      continue;
    }
    if (current === "--admin-dist") {
      out.adminDist = argv[i + 1];
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
  if (!out.dataDir && positional[2]) {
    out.dataDir = positional[2];
  }
  if (!out.adminDist && positional[3]) {
    out.adminDist = positional[3];
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

function parseOptionalInt(value: string | null) {
  if (value === null || value.trim() === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.floor(num);
}

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = parseOptionalInt(value);
  if (parsed === null) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function normalizeWsPath(value: string | undefined) {
  if (!value) {
    return "/ws";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function resolveRelayHome(value: string | undefined) {
  if (!value) {
    return path.join(os.homedir(), ".mimiclaw-relay");
  }
  return path.resolve(value);
}

function resolveAdminDistDir(value: string | undefined) {
  if (value) {
    return path.resolve(value);
  }
  const candidates = [
    path.resolve(process.cwd(), "admin-dist"),
    path.resolve(__dirname, "admin-dist"),
    path.resolve(__dirname, "..", "admin-dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

# Mimiclaw Relay Interface Specification

This document describes the current data exchange formats implemented in `websocket/server.ts`.

## 1. Service Endpoints

- WebSocket path: `/ws`
- HTTP API base path: `/api`
- Admin web app (static): `/`

Examples:
- Admin page: `http://127.0.0.1:8787/`
- API health: `http://127.0.0.1:8787/api/health`
- WebSocket: `ws://127.0.0.1:8787/ws`

Notes:
- Non-`/api` legacy API paths are still accepted for compatibility.
- All non-API HTTP paths are treated as admin static routes (SPA fallback to `index.html`).

## 2. Authentication Model

### 2.1 WebSocket auth

- First WS message must be `{"type":"auth", ...}`.
- Role `boss` must provide valid `authkey`.
- Role `employee` first registration (no `identity`) requires `name` and `tags`.
- Role `employee` reconnect uses `identity.id` and `identity.key`.

### 2.2 HTTP auth

Write endpoints require auth key:
- Header: `x-auth-key: <authkey>`
- Or query: `?authkey=<authkey>`

Read-only endpoints do not require auth:
- `GET /api/health`
- `GET /api/employees`
- `GET /api/connections`
- `GET /api/admin/workforce`
- `GET /api/admin/communications`

## 3. WebSocket Protocol

## 3.1 Server -> Client: hello

Sent immediately after WS connect.

```json
{
  "type": "hello",
  "message": "Please authenticate",
  "schema": {
    "type": "auth",
    "role": "boss|employee",
    "authkey": "required for boss",
    "name": "required when role=employee and first-time register",
    "tags": "required string[] when role=employee and first-time register",
    "health_report": {
      "type": "health_report",
      "valid": "boolean",
      "details": "optional object"
    },
    "identity": {
      "id": "optional reconnect id",
      "key": "optional reconnect key"
    }
  }
}
```

Auth timeout: 15 seconds (connection closed with code `4001`).

## 3.2 Client -> Server: auth

### Boss auth

```json
{
  "type": "auth",
  "role": "boss",
  "authkey": "your-secret"
}
```

### Employee first registration

```json
{
  "type": "auth",
  "role": "employee",
  "name": "Researcher-1",
  "tags": ["research", "risk"],
  "meta": {}
}
```

### Employee reconnect

```json
{
  "type": "auth",
  "role": "employee",
  "identity": {
    "id": "employee-xxxx",
    "key": "identity-key"
  },
  "name": "Researcher-1",
  "tags": ["research", "risk"]
}
```

Reconnect can optionally update employee `name/tags` when both are valid.

## 3.3 Server -> Client: auth_ok

```json
{
  "type": "auth_ok",
  "id": "employee-xxxx",
  "key": "identity-key",
  "role": "employee",
  "name": "Researcher-1",
  "tags": ["research", "risk"],
  "reconnected": false,
  "timestamp": 1700000000000
}
```

## 3.4 Client -> Server: ping

```json
{
  "type": "ping"
}
```

Server response:

```json
{
  "type": "pong",
  "timestamp": 1700000000000
}
```

## 3.5 Client -> Server: health_report

```json
{
  "type": "health_report",
  "valid": true,
  "details": {
    "heartbeat": "ok"
  }
}
```

Server response:

```json
{
  "type": "health_report_ack",
  "id": "employee-xxxx",
  "valid": true,
  "timestamp": 1700000000000
}
```

## 3.6 Client -> Server: message

```json
{
  "type": "message",
  "to": "employee-xxxx",
  "payload": {
    "task": "analyze"
  },
  "msg_id": "optional-uuid"
}
```

`to` supports:
- Single id string
- String array
- Broadcast: `"*"` or `"all"`

## 3.7 Server -> Target: routed message

```json
{
  "type": "message",
  "msg_id": "uuid",
  "from_id": "boss-xxxx",
  "from_role": "boss",
  "to": "employee-xxxx",
  "payload": {
    "task": "analyze"
  },
  "timestamp": 1700000000000
}
```

## 3.8 Server -> Sender: delivery_ack

```json
{
  "type": "delivery_ack",
  "msg_id": "uuid",
  "delivered": ["employee-xxxx"],
  "failed": [
    {
      "id": "employee-yyyy",
      "reason": "target_offline"
    }
  ],
  "timestamp": 1700000000000
}
```

Possible `failed.reason`:
- `target_not_found`
- `target_banned`
- `target_offline`

## 3.9 Server -> Employee: system ban event

```json
{
  "type": "system",
  "event": "banned",
  "by": "boss-http",
  "timestamp": 1700000000000
}
```

Then socket is closed with code `4008`.

## 3.10 Server -> Client: error

```json
{
  "type": "error",
  "code": "invalid_json",
  "message": "Message must be valid JSON.",
  "timestamp": 1700000000000
}
```

Common error codes:
- `invalid_json`
- `auth_required`
- `invalid_role`
- `invalid_authkey`
- `invalid_identity`
- `identity_not_found`
- `invalid_identity_key`
- `role_mismatch`
- `banned`
- `invalid_name`
- `invalid_tags`
- `invalid_to`
- `invalid_health_report`
- `unsupported_type`
- `unknown_identity`

## 3.11 WebSocket close codes used by server

- `4000`: old session closed because same identity reconnected elsewhere
- `4001`: auth timeout
- `4003`: auth rejected
- `4008`: employee banned by boss
- `1001`: server shutdown
- `1011`: internal identity error

## 4. HTTP API

All examples below use `/api/*` paths.

## 4.1 GET /api/health

No auth required.

Response:

```json
{
  "ok": true,
  "service": "mimiclaw-websocket",
  "now": 1700000000000,
  "active_connections": 2,
  "relay_home": "C:\\Users\\name\\.mimiclaw-relay",
  "admin_dist": "C:\\...\\websocket\\admin-dist"
}
```

## 4.2 GET /api/employees

No auth required.

Response:

```json
{
  "employees": [
    {
      "id": "employee-xxxx",
      "role": "employee",
      "name": "Coder-1",
      "tags": ["code", "ts"],
      "online": true,
      "status": "online",
      "banned": false,
      "created_at": 1700000000000,
      "last_seen": 1700000001000,
      "meta": {}
    }
  ]
}
```

## 4.3 GET /api/connections

No auth required.

Returns all identities (boss + employees) with current connection status.

## 4.4 GET /api/admin/workforce

No auth required.

Query params:
- `tag` (optional): filter employees by exact tag

Response shape:

```json
{
  "summary": {
    "total_nodes": 3,
    "boss_count": 1,
    "employee_count": 2,
    "online_count": 2,
    "offline_count": 1,
    "banned_count": 0,
    "health": {
      "healthy": 1,
      "degraded": 1,
      "unhealthy": 1
    },
    "filtered_by_tag": null
  },
  "bosses": [],
  "employees": [],
  "employees_by_tag": {
    "research": {
      "count": 1,
      "employee_ids": ["employee-xxxx"],
      "employees": []
    }
  },
  "timestamp": 1700000000000
}
```

Node health object:

```json
{
  "overall": "healthy|degraded|unhealthy",
  "reasons": ["heartbeat_stale", "self_report_missing"],
  "status": "online|offline|banned",
  "online": true,
  "heartbeat": {
    "last_seen_at": 1700000000000,
    "age_ms": 1200,
    "stale": false,
    "stale_threshold_ms": 60000
  },
  "self_report": {
    "valid": true,
    "last_report_at": 1700000000000,
    "age_ms": 2000,
    "stale": false,
    "stale_threshold_ms": 180000
  },
  "connection": {
    "last_connected_at": 1700000000000,
    "last_disconnected_at": null,
    "websocket_open": true
  }
}
```

## 4.5 GET /api/admin/communications

No auth required.

Query params:
- `limit` (default `50`, min `1`, max `500`)
- `offset` (default `0`)
- `boss_id` (optional)
- `employee_id` (optional)
- `tag` (optional, matches employee tags)
- `since` (optional unix ms)
- `until` (optional unix ms)

Response shape:

```json
{
  "total": 2,
  "offset": 0,
  "limit": 50,
  "filters": {
    "boss_id": null,
    "employee_id": null,
    "tag": null,
    "since": null,
    "until": null
  },
  "rows": [
    {
      "msg_id": "uuid",
      "timestamp": 1700000000000,
      "direction": "boss_to_employee",
      "boss": {
        "id": "boss-xxxx",
        "role": "boss",
        "name": null,
        "tags": []
      },
      "employee": {
        "id": "employee-xxxx",
        "role": "employee",
        "name": "Coder-1",
        "tags": ["code"]
      },
      "from": {
        "id": "boss-xxxx",
        "role": "boss",
        "name": null,
        "tags": []
      },
      "to": {
        "id": "employee-xxxx",
        "role": "employee",
        "name": "Coder-1",
        "tags": ["code"]
      },
      "delivery": {
        "status": "delivered|failed|unknown",
        "reason": null
      },
      "payload": {}
    }
  ],
  "timestamp": 1700000000000
}
```

Only boss<->employee message edges are included.

## 4.6 POST/PUT /api/employees/:id/ban

Auth required.

Request body (optional):

```json
{
  "banned": true
}
```

- Default when body missing: `banned = true`

Response:

```json
{
  "id": "employee-xxxx",
  "role": "employee",
  "name": "Coder-1",
  "tags": ["code"],
  "banned": true,
  "online": false
}
```

## 4.7 DELETE /api/employees/:id/ban

Auth required.

Equivalent to unban (`banned = false`).

Response shape is same as section 4.6.

## 5. Persistence Model

Data directory:
- Default: `~/.mimiclaw-relay`
- Override: `--data-dir` or `MIMICLAW_RELAY_HOME`

Datastore files:
- `identities.db`: identity profile and latest status
- `connections.db`: auth/reconnect/disconnect/ban/unban/auth_fail events
- `messages.db`: routed message logs and delivery result

## 6. Static Admin Hosting

Admin dist directory:
- Default resolution checks:
- `./admin-dist` (from current working directory)
- `<runtime>/admin-dist`
- `<runtime>/../admin-dist`
- Override: `--admin-dist` or `MIMICLAW_ADMIN_DIST`

Routing behavior:
- If static file exists, it is served directly.
- If static file does not exist, server falls back to `index.html` (SPA routing).

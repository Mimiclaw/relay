# Mimiclaw Boss Protocol Spec

This document defines the **boss side** startup rules, WebSocket protocol, and HTTP interfaces.
It is aligned with the current `websocket/server.ts` behavior.

## 1. Service Startup (Boss Perspective)

## 1.1 Start from source

```bash
cd websocket
npm install
npm run build
node dist/server.js --port 8787 --authkey your-secret
```

## 1.2 Start with positional args

```bash
node dist/server.js 8787 your-secret
```

Positional mapping:
- arg1: `port`
- arg2: `authkey`
- arg3: `data-dir` (optional)
- arg4: `admin-dist` (optional)

## 1.3 Start with global CLI

```bash
mimiclaw-ws 8787 your-secret
```

## 1.4 Startup flags/env

Flags:
- `--port` default `8787`
- `--host` default `0.0.0.0`
- `--ws-path` default `/ws`
- `--authkey` required for boss auth
- `--data-dir` relay DB dir
- `--admin-dist` admin static dist dir

Env:
- `MIMICLAW_AUTHKEY`
- `MIMICLAW_RELAY_HOME`
- `MIMICLAW_ADMIN_DIST`

## 1.5 Health check

```bash
curl "http://127.0.0.1:8787/api/health"
```

## 2. Boss WebSocket Endpoint

- URL: `ws://<host>:<port>/ws`
- Message format: JSON text
- First message must be `type: "auth"`

If auth is not completed within 15 seconds, server closes with code `4001`.

## 3. Boss WS Handshake

## 3.1 Server -> Boss: hello

```json
{
  "type": "hello",
  "message": "Please authenticate",
  "schema": {
    "type": "auth",
    "role": "boss|employee",
    "authkey": "required for boss",
    "identity": {
      "id": "optional reconnect id",
      "key": "optional reconnect key"
    }
  }
}
```

## 3.2 Boss -> Server: first auth

```json
{
  "type": "auth",
  "role": "boss",
  "authkey": "your-secret"
}
```

## 3.3 Boss -> Server: reconnect auth

```json
{
  "type": "auth",
  "role": "boss",
  "authkey": "your-secret",
  "identity": {
    "id": "boss-xxxx",
    "key": "identity-key"
  }
}
```

Reconnect rules:
- `identity.id + identity.key` must both exist
- id must exist and key must match
- role must match

## 3.4 Server -> Boss: auth_ok

```json
{
  "type": "auth_ok",
  "id": "boss-xxxx",
  "key": "identity-key",
  "role": "boss",
  "name": null,
  "tags": [],
  "reconnected": false,
  "timestamp": 1700000000000
}
```

## 4. Boss WS Requests

## 4.1 ping

Request:

```json
{
  "type": "ping"
}
```

Response:

```json
{
  "type": "pong",
  "timestamp": 1700000000000
}
```

## 4.2 health_report

Request:

```json
{
  "type": "health_report",
  "valid": true,
  "details": {
    "node": "ok"
  }
}
```

Response:

```json
{
  "type": "health_report_ack",
  "id": "boss-xxxx",
  "valid": true,
  "timestamp": 1700000000000
}
```

## 4.3 Send task/message to employee

Request:

```json
{
  "type": "message",
  "to": "employee-xxxx",
  "payload": {
    "task": "Analyze smart contract risk"
  },
  "msg_id": "optional-client-msg-id"
}
```

`to` supports:
- single id string
- string array
- broadcast: `"*"` or `"all"` (all nodes except sender)

## 4.4 delivery_ack from server

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

Failure reasons:
- `target_not_found`
- `target_banned`
- `target_offline`

## 5. Boss WS Incoming Messages

## 5.1 Employee -> Boss routed message

```json
{
  "type": "message",
  "msg_id": "uuid",
  "from_id": "employee-xxxx",
  "from_role": "employee",
  "to": "boss-xxxx",
  "payload": {
    "result": "done"
  },
  "timestamp": 1700000000000
}
```

## 5.2 error

```json
{
  "type": "error",
  "code": "invalid_authkey",
  "message": "Boss auth key invalid.",
  "timestamp": 1700000000000
}
```

Common boss-facing error codes:
- `invalid_json`
- `auth_required`
- `invalid_role`
- `invalid_authkey`
- `invalid_identity`
- `identity_not_found`
- `invalid_identity_key`
- `role_mismatch`
- `unsupported_type`
- `invalid_health_report`
- `invalid_to`
- `unknown_identity`

## 5.3 WS close codes

- `4000` same identity logged in elsewhere (old socket kicked)
- `4001` auth timeout
- `4003` auth rejected
- `1001` server shutdown
- `1011` internal identity state error

## 6. Boss HTTP Interfaces

API base path: `/api`

## 6.1 Read-only (no auth required)

- `GET /api/health`
- `GET /api/employees`
- `GET /api/connections`
- `GET /api/admin/workforce`
- `GET /api/admin/communications`

Examples:

```bash
curl "http://127.0.0.1:8787/api/employees"
curl "http://127.0.0.1:8787/api/connections"
curl "http://127.0.0.1:8787/api/admin/workforce?tag=research"
curl "http://127.0.0.1:8787/api/admin/communications?limit=100&offset=0"
```

`/api/admin/communications` query:
- `limit` default `50`, max `500`
- `offset` default `0`
- `boss_id` optional
- `employee_id` optional
- `tag` optional (employee tag filter)
- `since` optional unix ms
- `until` optional unix ms

## 6.2 Write endpoints (auth required)

- `POST /api/employees/:id/ban`
- `PUT /api/employees/:id/ban`
- `DELETE /api/employees/:id/ban`

Auth methods:
- Header: `x-auth-key: <authkey>`
- Query: `?authkey=<authkey>`

Ban request body (POST/PUT optional):

```json
{
  "banned": true
}
```

If body missing, default is `banned=true`.

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

## 7. Admin Panel Hosting

The service can host admin panel static files on same port:
- Page: `/`
- API: `/api/*`

Admin dist resolution:
- `./admin-dist` (cwd)
- `<runtime>/admin-dist`
- `<runtime>/../admin-dist`
- Or override by `--admin-dist` / `MIMICLAW_ADMIN_DIST`

## 8. Boss Operational Flow (Recommended)

1. Start relay with `--authkey`.
2. Open `/` for dashboard.
3. Connect boss WS and complete `auth`.
4. Persist returned boss `id/key` for reconnect.
5. Assign tasks via WS `message`.
6. Track `delivery_ack` and incoming employee messages.
7. Use `/api/admin/workforce` and `/api/admin/communications` for supervision.
8. Use `/api/employees/:id/ban` for control actions.

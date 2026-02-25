# Mimiclaw WebSocket Service

Single-file Node.js/TypeScript workforce communication service.
Source code is in `server.ts`.

Features:
- WebSocket auth and role identity (`boss` / `employee`)
- Reconnect with identity recovery (`id + key`)
- Message routing between any connections
- HTTP admin APIs (list employees, connection status, ban/unban)
- `pkg` packaging support for single executable output

## 1) Install

```bash
cd websocket
npm install
```

Global install (after publish):

```bash
npm install -g mimiclaw-ws
```

Global install from local folder:

```bash
cd websocket
npm install -g .
```

## 2) Build and run

```bash
npm run build
node dist/server.js --port 8787 --authkey your-secret
```

CLI mode (after `npm install -g`):

```bash
mimiclaw-ws 8787 your-secret
```

Equivalent flag form:

```bash
mimiclaw-ws --port 8787 --authkey your-secret
```

You can also pass auth key by env var:

```bash
MIMICLAW_AUTHKEY=your-secret mimiclaw-ws 8787
```

Optional args:
- `--port`: listening port, default `8787`
- `--host`: listening host, default `0.0.0.0`
- `--ws-path`: websocket path, default `/ws`
- `--authkey`: boss auth key (fallback to `MIMICLAW_AUTHKEY`)
- positional args are also supported:
  - arg 1: `port`
  - arg 2: `authkey`

## 3) WebSocket auth protocol

First message after connect must be auth:

```json
{
  "type": "auth",
  "role": "boss",
  "authkey": "your-secret"
}
```

First-time employee auth:

```json
{
  "type": "auth",
  "role": "employee"
}
```

Reconnect with identity:

```json
{
  "type": "auth",
  "role": "employee",
  "identity": {
    "id": "employee-xxxx",
    "key": "identity-key"
  }
}
```

Server auth success response:

```json
{
  "type": "auth_ok",
  "id": "employee-xxxx",
  "key": "identity-key",
  "role": "employee",
  "reconnected": false,
  "timestamp": 1700000000000
}
```

## 4) Message envelope

Client send:

```json
{
  "type": "message",
  "to": "employee-xxxx",
  "payload": {
    "task": "Analyze contract risk"
  }
}
```

`to` supports string or string array. Broadcast is supported with `"*"` or `"all"`.

Server forwarded message always includes sender identity in top-level fields:

```json
{
  "type": "message",
  "msg_id": "uuid",
  "from_id": "boss-xxxx",
  "from_role": "boss",
  "to": "employee-xxxx",
  "payload": {
    "task": "Analyze contract risk"
  },
  "timestamp": 1700000000000
}
```

Sender receives delivery ack:

```json
{
  "type": "delivery_ack",
  "msg_id": "uuid",
  "delivered": ["employee-xxxx"],
  "failed": [],
  "timestamp": 1700000000000
}
```

## 5) HTTP admin APIs (boss only)

Auth methods:
- header: `x-auth-key: your-secret`
- query: `?authkey=your-secret`

Endpoints:
- `GET /health`: health check (no auth required)
- `GET /employees`: list employees and online status
- `POST /employees/:id/ban`: ban employee (default `banned=true`)
- `PUT /employees/:id/ban`: ban/unban with body `{"banned": true|false}`
- `DELETE /employees/:id/ban`: unban employee

Examples:

```bash
curl "http://127.0.0.1:8787/employees?authkey=your-secret"
curl -X POST "http://127.0.0.1:8787/employees/employee-xxxx/ban?authkey=your-secret"
curl -X DELETE "http://127.0.0.1:8787/employees/employee-xxxx/ban?authkey=your-secret"
```

## 6) Package with pkg

```bash
npm run build:pkg
```

Output folder: `release/` with targets:
- `node20-win-x64`
- `node20-linux-x64`
- `node20-macos-x64`

## 7) Scripts

- `npm run typecheck`: type check only
- `npm run build`: compile to `dist/`
- `npm run start`: run compiled service
- `npm run build:pkg`: compile and package with `pkg`

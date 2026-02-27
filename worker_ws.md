# Mimiclaw Worker WebSocket Spec

This document defines the **employee(worker) side** WebSocket request and interaction protocol.
It is based on the current implementation in `websocket/server.ts`.

## 1. Endpoint and Transport

- URL: `ws://<host>:<port>/ws`
- Protocol: WebSocket text frames (JSON payloads)
- Encoding: UTF-8 JSON

Notes:
- The first message from worker must be `type: "auth"`.
- If first auth is not received within 15 seconds, server closes connection (`code=4001`).

## 2. Worker Identity Model

Server assigns each worker:
- `id` (e.g. `employee-...`)
- `key` (identity secret for reconnect)

Worker must persist `id + key` locally for reconnect.

## 3. Connection Handshake

## 3.1 Server -> Worker: hello

Sent immediately after connect:

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

## 3.2 Worker -> Server: auth (first-time registration)

Use this when no prior identity exists.

```json
{
  "type": "auth",
  "role": "employee",
  "name": "Researcher-1",
  "tags": ["research", "risk"],
  "meta": {
    "version": "1.0.0"
  }
}
```

Validation rules:
- `role` must be `"employee"`.
- `name` must be non-empty string.
- `tags` must be string array with at least one non-empty item.
- `authkey` is optional for employee.
- If employee provides `authkey`, it must match server auth key.

## 3.3 Worker -> Server: auth (reconnect)

Use this when worker already has `id + key`.

```json
{
  "type": "auth",
  "role": "employee",
  "identity": {
    "id": "employee-xxxx",
    "key": "identity-key"
  },
  "name": "Researcher-1",
  "tags": ["research", "risk"],
  "meta": {
    "instance": "pod-3"
  }
}
```

Reconnect rules:
- `identity.id` and `identity.key` must both exist.
- `id` must exist on server.
- `key` must match stored identity key.
- `role` must match stored role (`employee`).
- If worker is banned, reconnect is rejected.
- Optional profile update (`name/tags`) is accepted only when valid.

## 3.4 Server -> Worker: auth_ok

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

Fields:
- `reconnected=false`: new identity was created.
- `reconnected=true`: previous identity restored.

## 4. Worker Requests After Auth

## 4.1 Heartbeat ping

Worker request:

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

## 4.2 Self health report

Worker request:

```json
{
  "type": "health_report",
  "valid": true,
  "details": {
    "cpu": "ok",
    "model": "active"
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

Rules:
- `valid` must be boolean.
- `details` is optional and currently not echoed back.

## 4.3 Send message to other nodes

Worker request:

```json
{
  "type": "message",
  "to": "boss-xxxx",
  "payload": {
    "result": "analysis done"
  },
  "msg_id": "optional-client-msg-id"
}
```

`to` supports:
- single string id
- string array
- broadcast `"*"` or `"all"` (all identities except sender)

If `msg_id` is omitted, server generates one.

## 4.4 Delivery acknowledgement

When worker sends `type=message`, server returns:

```json
{
  "type": "delivery_ack",
  "msg_id": "uuid",
  "delivered": ["boss-xxxx"],
  "failed": [
    {
      "id": "employee-yyyy",
      "reason": "target_offline"
    }
  ],
  "timestamp": 1700000000000
}
```

Possible `failed.reason` values:
- `target_not_found`
- `target_banned`
- `target_offline`

## 5. Incoming Messages Worker Must Handle

## 5.1 Routed message from other node

```json
{
  "type": "message",
  "msg_id": "uuid",
  "from_id": "boss-xxxx",
  "from_role": "boss",
  "to": "employee-xxxx",
  "payload": {
    "task": "analyze contract"
  },
  "timestamp": 1700000000000
}
```

Top-level sender fields are always included:
- `from_id`
- `from_role`

## 5.2 System ban event

```json
{
  "type": "system",
  "event": "banned",
  "by": "boss-http",
  "timestamp": 1700000000000
}
```

After this event, server closes connection (`code=4008`).

## 5.3 Error message

```json
{
  "type": "error",
  "code": "invalid_json",
  "message": "Message must be valid JSON.",
  "timestamp": 1700000000000
}
```

## 6. Employee-Facing Error Codes

Handshake/auth errors:
- `auth_required`: first message was not auth
- `invalid_role`: role is not `boss|employee`
- `invalid_authkey`: employee provided wrong authkey / boss authkey invalid
- `invalid_identity`: reconnect missing identity.id or identity.key
- `identity_not_found`: reconnect id not found
- `invalid_identity_key`: reconnect key mismatch
- `role_mismatch`: reconnect role mismatch
- `banned`: employee identity is banned
- `invalid_name`: employee registration missing/empty name
- `invalid_tags`: employee registration tags invalid

Post-auth errors:
- `invalid_json`: malformed JSON
- `unknown_identity`: server lost identity binding for this socket
- `invalid_health_report`: health_report.valid not boolean
- `unsupported_type`: unsupported `type`
- `invalid_to`: message.to invalid/empty

## 7. WebSocket Close Codes Relevant to Worker

- `4000`: same identity connected from another session (old one closed)
- `4001`: auth timeout
- `4003`: auth rejected by server
- `4008`: banned by boss
- `1001`: server shutdown
- `1011`: internal identity error

## 8. Recommended Worker Interaction Flow

1. Connect to `/ws`.
2. Wait for `hello`.
3. Send `auth`.
4. On `auth_ok`, persist `id/key`.
5. Start periodic `ping` (e.g. every 10-30s).
6. Optionally send periodic `health_report`.
7. Receive `message` tasks and respond with `message`.
8. Track `delivery_ack` for sent messages.
9. On disconnect, reconnect using saved `id/key`.

## 9. JSON Contract Summary (Worker Outbound)

```json
{
  "type": "auth",
  "role": "employee",
  "authkey": "optional",
  "name": "required on first register",
  "tags": ["required on first register"],
  "identity": {
    "id": "required for reconnect",
    "key": "required for reconnect"
  },
  "meta": {}
}
```

```json
{
  "type": "ping"
}
```

```json
{
  "type": "health_report",
  "valid": true,
  "details": {}
}
```

```json
{
  "type": "message",
  "to": "string | string[] | '*' | 'all'",
  "payload": {},
  "msg_id": "optional"
}
```

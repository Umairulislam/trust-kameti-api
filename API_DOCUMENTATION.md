# API Documentation — Trust Kameti Backend

REST API reference for the backend of the Trust Kameti (digital kameti) platform.
All endpoints, schemas, and examples below are derived directly from the source code.

## Table of Contents

1. [Conventions](#conventions)
2. [Health](#health)
3. [Auth](#auth)
4. [Committees](#committees)
5. [Members](#members)
6. [Invitations](#invitations)
7. [Cycles](#cycles)
8. [Contributions](#contributions)
9. [Payments](#payments)
10. [Lottery](#lottery)
11. [Payouts](#payouts)
12. [Audit Trail](#audit-trail)
13. [Notifications](#notifications)
14. [Reports](#reports)
15. [AI Committee Assistant](#ai-committee-assistant)
16. [Background Jobs](#background-jobs)
17. [Enum Reference](#enum-reference)
18. [Notes and Known Ambiguities](#notes-and-known-ambiguities)

---

## Conventions

**Base URL:** `http://localhost:3000` (configurable via `PORT`).

**Authentication:** JWT delivered in an HTTP-only cookie named `jwt` (7-day expiry, `SameSite=Lax`).
Login/register responses set the cookie automatically — send requests with `credentials: 'include'`
(or `withCredentials: true` in axios) and no `Authorization` header is needed.

**Authorization levels used throughout this document:**

| Level | Meaning |
|---|---|
| Public | No authentication required (`@Public()` decorator) |
| User | Any authenticated user with an ACTIVE account |
| Platform Admin | Authenticated user with `role: ADMIN` (enforced by `AdminGuard`) |
| Committee Admin | Service-level check: requesting user is the committee's creator (`committee.createdBy`) |
| Committee Member | Creator or a member with a non-REMOVED membership |

Several write endpoints require **Platform Admin + Committee Admin** (both the role guard and the
creator check apply). See [Notes and Known Ambiguities](#notes-and-known-ambiguities).

**Request validation:** A global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted`,
and `transform` — unknown fields are rejected with `400`, and query/page params are type-coerced.

**Pagination envelope** (list endpoints):

```json
{ "data": [ ... ], "total": 42, "page": 1, "limit": 10 }
```

**Error shape** (all non-2xx responses):

```json
{ "statusCode": 403, "message": "You do not have access to this committee", "error": "Forbidden" }
```

**Money:** Prisma `Decimal(12,2)` fields are serialized as **strings** (e.g. `"5000.00"`) in raw
model responses. Report endpoints convert amounts to JSON **numbers**.

**Dates:** ISO 8601 strings in UTC. Nullable date fields (e.g. `endDate`, `paidAt`) are `null` until set.

**Status codes:** `POST` creation endpoints return `201 Created`; everything else returns `200 OK`.

---

## Health

### GET /

Liveness/readiness check; verifies database connectivity.

**Auth:** Public

**Success response:**

```json
{ "status": "ok", "database": "connected", "timestamp": "2026-09-04T09:00:00.000Z" }
```

**Example:**

```http
GET /
```

```json
{ "status": "ok", "database": "connected", "timestamp": "2026-09-04T09:00:00.000Z" }
```

---

## Auth

### POST /auth/register

Create a new account (default role `USER`, status `ACTIVE`) and log the user in.

**Auth:** Public

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| name | string | yes | non-empty |
| email | string | yes | valid email, unique |
| password | string | yes | min 8 characters |
| phone | string | no | — |

**Success response (`201`):** `{ message, user }` where `user` is the safe user object (no `passwordHash`). Sets the `jwt` cookie.

**Key errors:** `400` validation failed · `409` email already registered

**Example:**

```http
POST /auth/register
```

```json
{
  "name": "Ayesha Khan",
  "email": "ayesha@example.com",
  "password": "str0ngP@ss",
  "phone": "+92 300 1234567"
}
```

Response (`201`):

```json
{
  "message": "Registration successful",
  "user": {
    "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
    "name": "Ayesha Khan",
    "email": "ayesha@example.com",
    "phone": "+92 300 1234567",
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-09-04T09:00:00.000Z",
    "updatedAt": "2026-09-04T09:00:00.000Z"
  }
}
```

### POST /auth/login

Authenticate with email/password and receive the session cookie.

**Auth:** Public

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| email | string | yes | valid email |
| password | string | yes | non-empty |

**Success response (`201`):** `{ message, user }`. Sets the `jwt` cookie.

**Key errors:** `400` validation failed · `401` invalid credentials · `401` account not active (SUSPENDED/INACTIVE)

**Example:**

```http
POST /auth/login
```

```json
{ "email": "ayesha@example.com", "password": "str0ngP@ss" }
```

Response (`201`):

```json
{
  "message": "Login successful",
  "user": {
    "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
    "name": "Ayesha Khan",
    "email": "ayesha@example.com",
    "phone": "+92 300 1234567",
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-09-04T09:00:00.000Z",
    "updatedAt": "2026-09-04T09:00:00.000Z"
  }
}
```

### POST /auth/logout

Clear the session cookie. No server-side token revocation.

**Auth:** User

**Success response (`200`):** `{ "message": "Logout successful" }`

**Example:**

```http
POST /auth/logout
```

```json
{ "message": "Logout successful" }
```

### GET /auth/me

Return the authenticated user's profile.

**Auth:** Active `USER` or `ADMIN`, using the `jwt` cookie. Returns only the caller's
profile; no user ID is accepted to select another account.

**Success response (`200`):** safe user object.

**Key errors:** `401` missing/invalid cookie or user no longer exists

**Example:**

```http
GET /auth/me
Cookie: jwt=<token>
```

```json
{
  "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
  "name": "Ayesha Khan",
  "email": "ayesha@example.com",
  "phone": "+92 300 1234567",
  "role": "USER",
  "status": "ACTIVE",
  "createdAt": "2026-09-04T09:00:00.000Z",
  "updatedAt": "2026-09-04T09:00:00.000Z"
}
```

---

### PATCH /auth/me

Update the current authenticated profile. Available to both `USER` and `ADMIN`
accounts with `ACTIVE` status. The backend takes the user ID from the JWT session.

**Request body:** `UpdateProfileDto`. Provide at least one supported field.

| Field | Type | Required | Constraints |
|---|---|---|---|
| name | string | no | trimmed, non-empty, maximum 100 characters; cannot be null |
| phone | string or null | no | strings are trimmed, non-empty, maximum 32 characters; null clears the phone |

Omitted fields retain their current values. Phone numbers remain free-form strings,
consistent with registration; this endpoint does not verify phone ownership.

Unknown fields are rejected with `400`, including `email`, `role`, `status`,
`password`, `passwordHash`, IDs, ownership fields, timestamps and relation objects.
Notification preferences are not supported by the current Prisma schema and cannot
be updated. No schema migration is required.

**Success response (`200`):** updated safe user object, with the same shape as
`GET /auth/me`; never includes `passwordHash`.

**Key errors:** `400` invalid fields or empty update; `401` missing, invalid or
expired cookie, deleted account, or inactive/suspended account.

```http
PATCH /auth/me
Cookie: jwt=<token>
Content-Type: application/json

{
  "name": "Ayesha Ahmed",
  "phone": "+92 300 7654321"
}
```

```json
{
  "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
  "name": "Ayesha Ahmed",
  "email": "ayesha@example.com",
  "phone": "+92 300 7654321",
  "role": "USER",
  "status": "ACTIVE",
  "createdAt": "2026-09-04T09:00:00.000Z",
  "updatedAt": "2026-09-09T09:00:00.000Z"
}
```

#### Testing profile endpoints

1. Log in through `POST /auth/login` with an existing active USER account and
   retain the `jwt` cookie in your API client.
2. Call `GET /auth/me`, then `PATCH /auth/me` with the example above. Confirm
   `200`, the updated safe profile and no `passwordHash`. Read the profile again
   to confirm persistence.
3. Test partial updates with only `name` and with `{ "phone": null }`.
4. Submit `{ "name": "Valid Name", "role": "ADMIN" }`, `{ "name": null }`,
   `{ "name": "   " }` and `{}`. Each must return `400` without changing the profile.
5. Remove the cookie and confirm both endpoints return `401`.
6. Repeat with an existing active ADMIN account. Only that admin's profile changes.

Browser requests must use `credentials: 'include'`, as for the existing auth API.

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand --testPathPattern=profile.e2e-spec.ts
npx --no-install tsc --noEmit --incremental false
```

The profile HTTP integration tests use real Nest routing, DTO validation, cookie
parsing, JWT verification and auth/users services, with an in-memory Prisma mock.
They do not connect to PostgreSQL, Redis or the AI provider. They cover both roles,
partial updates, protected fields, invalid input and authentication failures.

---

## Committees

> **Note:** The entire Committees controller is guarded by the platform-level `AdminGuard`
> (`role: ADMIN`). See [Notes and Known Ambiguities](#notes-and-known-ambiguities).

### POST /committees

Create a committee. The creator becomes the committee admin. Records a `COMMITTEE_CREATED` audit entry.

**Auth:** Platform Admin

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| name | string | yes | non-empty |
| description | string | no | — |
| contributionAmount | number | yes | ≥ 1, max 2 decimal places |
| memberLimit | integer | yes | ≥ 2 |
| totalCycles | integer | yes | ≥ 1 |
| startDate | string | yes | ISO 8601 date |
| dueDay | integer | yes | 1–31 |

**Success response (`201`):** Committee object with nested `creator`.

**Key errors:** `400` validation failed

**Example:**

```http
POST /committees
Cookie: jwt=<admin-token>
```

```json
{
  "name": "Friday Kameti",
  "description": "Neighbourhood monthly savings group",
  "contributionAmount": 5000,
  "memberLimit": 10,
  "totalCycles": 10,
  "startDate": "2026-10-01",
  "dueDay": 5
}
```

Response (`201`):

```json
{
  "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "name": "Friday Kameti",
  "description": "Neighbourhood monthly savings group",
  "contributionAmount": "5000.00",
  "memberLimit": 10,
  "totalCycles": 10,
  "payoutMethod": "LOTTERY",
  "startDate": "2026-10-01T00:00:00.000Z",
  "dueDay": 5,
  "status": "DRAFT",
  "createdBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "createdAt": "2026-09-04T09:05:00.000Z",
  "updatedAt": "2026-09-04T09:05:00.000Z",
  "creator": {
    "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
    "name": "Bilal Ahmed",
    "email": "bilal@example.com"
  }
}
```

### GET /committees

List committees **created by the requesting admin**, newest first.

**Auth:** Platform Admin

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `CommitteeStatus` | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of committees with `creator`.

**Key errors:** `400` invalid query values

**Example:**

```http
GET /committees?status=ACTIVE&page=1&limit=10
Cookie: jwt=<admin-token>
```

```json
{
  "data": [
    {
      "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "name": "Friday Kameti",
      "description": "Neighbourhood monthly savings group",
      "contributionAmount": "5000.00",
      "memberLimit": 10,
      "totalCycles": 10,
      "payoutMethod": "LOTTERY",
      "startDate": "2026-10-01T00:00:00.000Z",
      "dueDay": 5,
      "status": "ACTIVE",
      "createdBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "createdAt": "2026-09-04T09:05:00.000Z",
      "updatedAt": "2026-09-04T10:00:00.000Z",
      "creator": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /committees/:id

Get one committee (must belong to the requesting admin).

**Auth:** Platform Admin

**Success response (`200`):** committee with `creator`.

**Key errors:** `404` committee not found · `403` not the creator

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d
Cookie: jwt=<admin-token>
```

```json
{
  "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "name": "Friday Kameti",
  "description": "Neighbourhood monthly savings group",
  "contributionAmount": "5000.00",
  "memberLimit": 10,
  "totalCycles": 10,
  "payoutMethod": "LOTTERY",
  "startDate": "2026-10-01T00:00:00.000Z",
  "dueDay": 5,
  "status": "ACTIVE",
  "createdBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "createdAt": "2026-09-04T09:05:00.000Z",
  "updatedAt": "2026-09-04T10:00:00.000Z",
  "creator": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

### PATCH /committees/:id

Update editable fields of a committee. Only allowed while status is `DRAFT`. Records a
`COMMITTEE_UPDATED` audit entry.

**Auth:** Platform Admin (creator)

**Request body:** all fields optional (partial of create schema).

**Success response (`200`):** updated committee with `creator`.

**Key errors:** `400` validation failed / not `DRAFT` · `403` not the creator · `404` not found

**Example:**

```http
PATCH /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d
Cookie: jwt=<admin-token>
```

```json
{ "name": "Friday Kameti — Block A", "memberLimit": 12 }
```

Response (`200`):

```json
{
  "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "name": "Friday Kameti — Block A",
  "description": "Neighbourhood monthly savings group",
  "contributionAmount": "5000.00",
  "memberLimit": 12,
  "totalCycles": 10,
  "payoutMethod": "LOTTERY",
  "startDate": "2026-10-01T00:00:00.000Z",
  "dueDay": 5,
  "status": "DRAFT",
  "createdBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "createdAt": "2026-09-04T09:05:00.000Z",
  "updatedAt": "2026-09-04T09:10:00.000Z",
  "creator": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

### PATCH /committees/:id/status

Transition committee status through the allowed lifecycle:
`DRAFT → ACTIVE | PAUSED | CANCELLED`, `ACTIVE → PAUSED | COMPLETED | CANCELLED`,
`PAUSED → ACTIVE | CANCELLED | COMPLETED`. `COMPLETED` and `CANCELLED` are terminal.
Executed atomically with a `COMMITTEE_STATUS_CHANGED` audit entry; notifies active members.

**Auth:** Platform Admin (creator)

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| status | enum `CommitteeStatus` | yes | see lifecycle above |

**Success response (`200`):** updated committee with `creator`.

**Key errors:** `400` invalid transition / same status · `403` not the creator · `404` not found

**Example:**

```http
PATCH /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/status
Cookie: jwt=<admin-token>
```

```json
{ "status": "ACTIVE" }
```

Response (`200`):

```json
{
  "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "name": "Friday Kameti — Block A",
  "description": "Neighbourhood monthly savings group",
  "contributionAmount": "5000.00",
  "memberLimit": 12,
  "totalCycles": 10,
  "payoutMethod": "LOTTERY",
  "startDate": "2026-10-01T00:00:00.000Z",
  "dueDay": 5,
  "status": "ACTIVE",
  "createdBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "createdAt": "2026-09-04T09:05:00.000Z",
  "updatedAt": "2026-09-04T10:00:00.000Z",
  "creator": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

### DELETE /committees/:id

Permanently delete a committee. Only allowed while status is `DRAFT` (non-draft committees
should be `CANCELLED` instead).

**Auth:** Platform Admin (creator)

**Success response (`200`):** `{ "message": "Committee deleted" }`

**Key errors:** `400` not `DRAFT` · `403` not the creator · `404` not found

**Example:**

```http
DELETE /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d
Cookie: jwt=<admin-token>
```

```json
{ "message": "Committee deleted" }
```

---

## Members

### GET /committees/my-committees

List the authenticated user's committee memberships (status `ACTIVE` or `INVITED`), newest joined first.
This is the primary committees entry point for regular (non-ADMIN-role) users.

**Auth:** User

**Success response (`200`):** array of `{ committee, role, status, joinedAt }`.

**Example:**

```http
GET /committees/my-committees
Cookie: jwt=<token>
```

```json
[
  {
    "committee": {
      "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "name": "Friday Kameti",
      "description": "Neighbourhood monthly savings group",
      "contributionAmount": "5000.00",
      "memberLimit": 10,
      "totalCycles": 10,
      "payoutMethod": "LOTTERY",
      "startDate": "2026-10-01T00:00:00.000Z",
      "dueDay": 5,
      "status": "ACTIVE",
      "createdAt": "2026-09-04T09:05:00.000Z"
    },
    "role": "MEMBER",
    "status": "ACTIVE",
    "joinedAt": "2026-09-04T11:00:00.000Z"
  }
]
```

### GET /committees/:committeeId/members

List members of a committee, newest first.

**Auth:** Committee Member

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `MemberStatus` | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of member records with nested `user`.

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/members?status=ACTIVE&page=1&limit=10
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "userId": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "role": "MEMBER",
      "status": "ACTIVE",
      "joinedAt": "2026-09-04T11:00:00.000Z",
      "removedAt": null,
      "createdAt": "2026-09-04T11:00:00.000Z",
      "updatedAt": "2026-09-04T11:00:00.000Z",
      "user": {
        "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "phone": "+92 300 1234567"
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /committees/:committeeId/members/:id

Get a single member record.

**Auth:** Committee Member

**Success response (`200`):** member record with nested `user`.

**Key errors:** `403` no access · `404` committee or member not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/members/d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a
Cookie: jwt=<token>
```

```json
{
  "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "userId": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
  "role": "MEMBER",
  "status": "ACTIVE",
  "joinedAt": "2026-09-04T11:00:00.000Z",
  "removedAt": null,
  "createdAt": "2026-09-04T11:00:00.000Z",
  "updatedAt": "2026-09-04T11:00:00.000Z",
  "user": {
    "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
    "name": "Ayesha Khan",
    "email": "ayesha@example.com",
    "phone": "+92 300 1234567"
  }
}
```

### DELETE /committees/:committeeId/members/:id

Soft-remove a member (sets status `REMOVED`, stamps `removedAt`). Records a `MEMBER_REMOVED`
audit entry. The requesting user must hold both the platform ADMIN role and committee ownership.

**Auth:** Platform Admin + Committee Admin

**Success response (`200`):** `{ "message": "Member removed" }`

**Key errors:** `400` member already removed · `403` not committee admin · `404` committee or member not found

**Example:**

```http
DELETE /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/members/d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a
Cookie: jwt=<admin-token>
```

```json
{ "message": "Member removed" }
```

---

## Invitations

Invitations let a committee admin add members by email. Managing invitations requires
the platform ADMIN role **and** committee ownership; accepting an invitation requires
only an authenticated account whose email matches the invitation, plus the token.

### POST /committees/:committeeId/invitations

Invite a user by email; creates a single-use invitation token (64 hex characters) with
a default 7-day expiry. Records a `MEMBER_INVITED` audit entry and notifies the invited
user if they already have an account.

**Auth:** Platform Admin + Committee Admin

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| email | string | yes | valid email |
| expiresAfterDays | integer | no | ≥ 1 (default 7) |

**Success response (`201`):** invitation with nested `committee` and `inviter`.

**Key errors:** `400` committee has reached its member limit · `403` not committee admin · `404` committee not found · `409` user is already a member (non-REMOVED) or a pending invitation already exists for this email

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/invitations
Cookie: jwt=<admin-token>
```

```json
{ "email": "sana@example.com", "expiresAfterDays": 7 }
```

Response (`201`):

```json
{
  "id": "e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "invitedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "email": "sana@example.com",
  "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "status": "PENDING",
  "expiresAt": "2026-09-11T09:30:00.000Z",
  "acceptedAt": null,
  "createdAt": "2026-09-04T09:30:00.000Z",
  "committee": { "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "name": "Friday Kameti" },
  "inviter": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

### GET /committees/:committeeId/invitations

List a committee's invitations, newest first.

**Auth:** Platform Admin + Committee Admin

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `InvitationStatus` | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of invitations with `committee` and `inviter`.

**Key errors:** `403` not committee admin · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/invitations?status=PENDING&page=1&limit=10
Cookie: jwt=<admin-token>
```

```json
{
  "data": [
    {
      "id": "e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "invitedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "email": "sana@example.com",
      "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "status": "PENDING",
      "expiresAt": "2026-09-11T09:30:00.000Z",
      "acceptedAt": null,
      "createdAt": "2026-09-04T09:30:00.000Z",
      "committee": { "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "name": "Friday Kameti" },
      "inviter": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /committees/:committeeId/invitations/:id

Get a single invitation.

**Auth:** Platform Admin + Committee Admin

**Success response (`200`):** invitation with `committee` and `inviter`.

**Key errors:** `403` not committee admin · `404` committee or invitation not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/invitations/e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b
Cookie: jwt=<admin-token>
```

```json
{
  "id": "e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "invitedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "email": "sana@example.com",
  "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "status": "ACCEPTED",
  "expiresAt": "2026-09-11T09:30:00.000Z",
  "acceptedAt": "2026-09-04T10:15:00.000Z",
  "createdAt": "2026-09-04T09:30:00.000Z",
  "committee": { "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "name": "Friday Kameti" },
  "inviter": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

### POST /invitations/accept

Accept an invitation token and join the committee. In a single transaction the invitation
is marked `ACCEPTED`, the membership is created (or a previously `REMOVED` membership is
reactivated as `ACTIVE`), and a `MEMBER_JOINED` audit entry is recorded. The committee
admin is notified. The authenticated user's email **must** match the invitation's email,
and the committee must be in `ACTIVE` status.

**Auth:** User

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| token | string | yes | non-empty |

**Success response (`201`):** object containing the accepted `invitation` (with nested `committee` and `inviter`) and the created/updated `membership`.

**Key errors:** `400` invitation already accepted/cancelled, or expired (lazily flipped to `EXPIRED`), or committee not currently accepting members · `403` email does not match invitation · `404` invalid token or committee not found · `409` accepting user is already a member

**Example:**

```http
POST /invitations/accept
Cookie: jwt=<token>
```

```json
{ "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0" }
```

Response (`201`):

```json
{
  "invitation": {
    "id": "e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
    "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "invitedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
    "email": "sana@example.com",
    "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
    "status": "ACCEPTED",
    "expiresAt": "2026-09-11T09:30:00.000Z",
    "acceptedAt": "2026-09-04T10:15:00.000Z",
    "createdAt": "2026-09-04T09:30:00.000Z",
    "committee": { "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "name": "Friday Kameti" },
    "inviter": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
  },
  "membership": {
    "id": "f2a3b4c5-6d7e-8f9a-0b1c-2d3e4f5a6b7c",
    "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "userId": "d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a",
    "role": "MEMBER",
    "status": "ACTIVE",
    "joinedAt": "2026-09-04T10:15:00.000Z"
  }
}
```

### POST /committees/:committeeId/invitations/:id/cancel

Cancel a pending invitation.

**Auth:** Platform Admin + Committee Admin

**Success response (`200`):** updated invitation (status `CANCELLED`).

**Key errors:** `400` invitation is not `PENDING` · `403` not committee admin · `404` committee or invitation not found

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/invitations/e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b/cancel
Cookie: jwt=<admin-token>
```

```json
{
  "id": "e1f2a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "invitedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "email": "kamran@example.com",
  "token": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
  "status": "CANCELLED",
  "expiresAt": "2026-09-12T09:30:00.000Z",
  "acceptedAt": null,
  "createdAt": "2026-09-05T09:30:00.000Z",
  "committee": { "id": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "name": "Friday Kameti" },
  "inviter": { "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e", "name": "Bilal Ahmed", "email": "bilal@example.com" }
}
```

---

## Cycles

### POST /committees/:committeeId/cycles/generate

Generate all of the committee's remaining cycles in one call (up to `totalCycles`
total), in a transaction. Cycle 1 is created `ACTIVE` with the start date; later cycles
are `UPCOMING` with `startDate: null`. Each cycle's `totalExpected` is
`contributionAmount × active members`.

**Auth:** Platform Admin + Committee Admin

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| startDate | string | no | ISO 8601 date; overrides the committee's start date for cycle 1 |

**Success response (`201`):** `{ generated, cycles }`.

**Key errors:** `400` committee not ACTIVE / no active members · `403` not committee admin · `404` committee not found · `409` all cycles already generated

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/generate
Cookie: jwt=<admin-token>
```

```json
{ "startDate": "2026-10-01" }
```

Response (`201`) — `generated` is 10; the first two cycles are shown:

```json
{
  "generated": 10,
  "cycles": [
    {
      "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleNumber": 1,
      "startDate": "2026-10-01T00:00:00.000Z",
      "endDate": null,
      "status": "ACTIVE",
      "totalExpected": "15000.00",
      "totalCollected": "0.00",
      "createdAt": "2026-09-04T11:00:00.000Z",
      "updatedAt": "2026-09-04T11:00:00.000Z"
    },
    {
      "id": "a3b4c5d6-7e8f-4a9b-0c1d-2e3f4a5b6c7d",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleNumber": 2,
      "startDate": null,
      "endDate": null,
      "status": "UPCOMING",
      "totalExpected": "15000.00",
      "totalCollected": "0.00",
      "createdAt": "2026-09-04T11:00:00.000Z",
      "updatedAt": "2026-09-04T11:00:00.000Z"
    }
  ]
}
```

### GET /committees/:committeeId/cycles

List a committee's cycles, ordered by cycle number ascending.

**Auth:** Committee Member

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `CycleStatus` | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of cycles.

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles?status=ACTIVE&page=1&limit=10
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleNumber": 1,
      "startDate": "2026-10-01T00:00:00.000Z",
      "endDate": null,
      "status": "ACTIVE",
      "totalExpected": "15000.00",
      "totalCollected": "0.00",
      "createdAt": "2026-09-04T11:00:00.000Z",
      "updatedAt": "2026-09-04T11:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /committees/:committeeId/cycles/:id

Get a single cycle.

**Auth:** Committee Member

**Success response (`200`):** cycle object.

**Key errors:** `403` no access · `404` committee or cycle not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c
Cookie: jwt=<token>
```

```json
{
  "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "cycleNumber": 1,
  "startDate": "2026-10-01T00:00:00.000Z",
  "endDate": null,
  "status": "ACTIVE",
  "totalExpected": "15000.00",
  "totalCollected": "10000.00",
  "createdAt": "2026-09-04T11:00:00.000Z",
  "updatedAt": "2026-10-02T09:00:00.000Z"
}
```

### PATCH /committees/:committeeId/cycles/:id/status

Transition a cycle's status. Valid transitions: `UPCOMING → ACTIVE | CANCELLED`,
`ACTIVE → COMPLETED | CANCELLED` (`COMPLETED`/`CANCELLED` are terminal). Only one cycle
may be `ACTIVE` at a time. Activating stamps `startDate` (if unset); completing stamps
`endDate` (if unset). Active members are notified on `ACTIVE`/`COMPLETED`.

**Auth:** Platform Admin + Committee Admin

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| status | enum `CycleStatus` | yes | see transitions above |

**Success response (`200`):** updated cycle.

**Key errors:** `400` invalid transition / same status / another cycle already active · `403` not committee admin · `404` committee or cycle not found

**Example:**

```http
PATCH /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/b5c6d7e8-9f0a-4b1c-2d3e-4f5a6b7c8d9e/status
Cookie: jwt=<admin-token>
```

```json
{ "status": "CANCELLED" }
```

Response (`200`):

```json
{
  "id": "b5c6d7e8-9f0a-4b1c-2d3e-4f5a6b7c8d9e",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "cycleNumber": 3,
  "startDate": null,
  "endDate": null,
  "status": "CANCELLED",
  "totalExpected": "15000.00",
  "totalCollected": "0.00",
  "createdAt": "2026-09-04T11:00:00.000Z",
  "updatedAt": "2026-09-05T08:00:00.000Z"
}
```

### POST /committees/:committeeId/cycles/start-next

Atomically complete the active cycle (stamps `endDate`) and activate the next
`UPCOMING` cycle (stamps `startDate`). If no next cycle exists, the committee itself is
marked `COMPLETED`. Active members are notified of the completion and the new cycle.

**Auth:** Platform Admin + Committee Admin

**Request body:** none.

**Success response (`201`):** `{ completed, activated, committeeCompleted }` — the two cycle objects or `null`.

**Key errors:** `400` committee not ACTIVE / no active cycle found · `403` not committee admin · `404` committee not found

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/start-next
Cookie: jwt=<admin-token>
```

Response (`201`):

```json
{
  "completed": {
    "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "cycleNumber": 1,
    "startDate": "2026-10-01T00:00:00.000Z",
    "endDate": "2026-10-31T12:00:00.000Z",
    "status": "COMPLETED",
    "totalExpected": "15000.00",
    "totalCollected": "10000.00",
    "createdAt": "2026-09-04T11:00:00.000Z",
    "updatedAt": "2026-10-31T12:00:00.000Z"
  },
  "activated": {
    "id": "a3b4c5d6-7e8f-4a9b-0c1d-2e3f4a5b6c7d",
    "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "cycleNumber": 2,
    "startDate": "2026-10-31T12:00:00.000Z",
    "endDate": null,
    "status": "ACTIVE",
    "totalExpected": "15000.00",
    "totalCollected": "0.00",
    "createdAt": "2026-09-04T11:00:00.000Z",
    "updatedAt": "2026-10-31T12:00:00.000Z"
  },
  "committeeCompleted": false
}
```

---

## Contributions

Contributions are per-member payment obligations for a cycle. The committee admin
generates them in bulk; amounts always equal the committee's `contributionAmount` and
are computed by the backend — clients never set them.

### POST /committees/:committeeId/cycles/:cycleId/contributions/generate

Create one `PENDING` contribution for every `ACTIVE` member of the cycle, in a
transaction. `dueDate` is the committee's `dueDay` clamped to the last day of the
cycle's start month, at 23:59:59.

**Auth:** Platform Admin + Committee Admin

**Success response (`201`):** `{ generated, contributions }` — raw contribution records
(no nested `member`).

**Key errors:** `400` cycle not `ACTIVE`, or committee has no active members · `403` not committee admin · `404` committee or cycle not found · `409` contributions already generated for this cycle

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/contributions/generate
Cookie: jwt=<admin-token>
```

Response (`201`) — `generated` is 3; two of the contributions are shown:

```json
{
  "generated": 3,
  "contributions": [
    {
      "id": "b4c5d6e7-8f9a-4b0c-1d2e-3f4a5b6c7d8e",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "memberId": "a5b6c7d8-9e0f-4a1b-2c3d-4e5f6a7b8c9d",
      "amount": "5000.00",
      "status": "PENDING",
      "dueDate": "2026-10-05T23:59:59.000Z",
      "paidAt": null,
      "paymentId": null,
      "createdAt": "2026-09-04T11:30:00.000Z",
      "updatedAt": "2026-09-04T11:30:00.000Z"
    },
    {
      "id": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "amount": "5000.00",
      "status": "PENDING",
      "dueDate": "2026-10-05T23:59:59.000Z",
      "paidAt": null,
      "paymentId": null,
      "createdAt": "2026-09-04T11:30:00.000Z",
      "updatedAt": "2026-09-04T11:30:00.000Z"
    }
  ]
}
```

### GET /committees/:committeeId/cycles/:cycleId/contributions/summary

Aggregated totals for a cycle's contributions.

**Auth:** Committee Member

**Success response (`200`):**

| Field | Type | Notes |
|---|---|---|
| totalExpected | number | sum of all contribution amounts |
| totalCollected | number | sum of `PAID` amounts |
| totalPending | number | sum of `PENDING` amounts |
| totalOverdue | number | sum of `OVERDUE` amounts |
| memberCount | number | number of contributions |

**Key errors:** `403` no access · `404` committee or cycle not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/contributions/summary
Cookie: jwt=<token>
```

```json
{
  "totalExpected": 15000,
  "totalCollected": 10000,
  "totalPending": 5000,
  "totalOverdue": 0,
  "memberCount": 3
}
```

### GET /committees/:committeeId/cycles/:cycleId/contributions

List a cycle's contributions with the paying member, oldest first.

**Auth:** Committee Member

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `ContributionStatus` (`PENDING` \| `PAID` \| `OVERDUE`) | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of contributions with nested `member.user`.

**Key errors:** `403` no access · `404` committee or cycle not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/contributions?status=PENDING&page=1&limit=10
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "b4c5d6e7-8f9a-4b0c-1d2e-3f4a5b6c7d8e",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "memberId": "a5b6c7d8-9e0f-4a1b-2c3d-4e5f6a7b8c9d",
      "amount": "5000.00",
      "status": "PENDING",
      "dueDate": "2026-10-05T23:59:59.000Z",
      "paidAt": null,
      "paymentId": null,
      "createdAt": "2026-09-04T11:30:00.000Z",
      "updatedAt": "2026-09-04T11:30:00.000Z",
      "member": {
        "id": "a5b6c7d8-9e0f-4a1b-2c3d-4e5f6a7b8c9d",
        "role": "ADMIN",
        "status": "ACTIVE",
        "user": {
          "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
          "name": "Bilal Ahmed",
          "email": "bilal@example.com",
          "phone": null
        }
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /committees/:committeeId/cycles/:cycleId/contributions/:id

Get a single contribution with its paying member.

**Auth:** Committee Member

**Success response (`200`):** contribution with nested `member.user`.

**Key errors:** `403` no access · `404` committee, cycle, or contribution not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/contributions/c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f
Cookie: jwt=<token>
```

```json
{
  "id": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
  "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "amount": "5000.00",
  "status": "PAID",
  "dueDate": "2026-10-05T23:59:59.000Z",
  "paidAt": "2026-10-03T10:00:00.000Z",
  "paymentId": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
  "createdAt": "2026-09-04T11:30:00.000Z",
  "updatedAt": "2026-10-03T10:00:00.000Z",
  "member": {
    "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "role": "MEMBER",
    "status": "ACTIVE",
    "user": {
      "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "phone": "+92 300 1234567"
    }
  }
}
```

### POST /committees/:committeeId/cycles/:cycleId/contributions/mark-overdue

Flip all past-due `PENDING` contributions of the cycle to `OVERDUE`. Records a
`CONTRIBUTION_STATUS_CHANGED` audit entry when at least one record changes.

**Auth:** Platform Admin + Committee Admin

**Success response (`200`):** `{ "marked": <count> }`

**Key errors:** `400` cycle is `COMPLETED` or `CANCELLED` · `403` not committee admin · `404` committee or cycle not found

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/contributions/mark-overdue
Cookie: jwt=<admin-token>
```

```json
{ "marked": 1 }
```

---

## Payments

Members transfer money externally using Easypaisa, JazzCash, a bank account or another
manual channel. The API records the claim and its receipt; it does not transfer money
or independently confirm the transaction.

Flow: create a `PENDING` claim ? upload its receipt ? admin checks the receiving
account ? admin verifies or rejects. Both creation and upload leave dues and cycle
totals unchanged. Only admin approval marks the contribution `PAID`.

Members can submit only their own contributions. The committee creator may record
and upload on behalf of a member; the payment remains attributed to that member.
The existing committee-wide payment list remains available to active members for
transparency, but receipt image access is restricted to the paying member and creator.

### POST /committees/:committeeId/payments

Create a payment claim. Upload the receipt afterwards using the returned payment ID.

**Auth:** Active Committee Member (own contribution) or Committee Creator.

**Content-Type:** `application/json`

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| contributionId | string | yes | non-empty; must belong to this committee and an ACTIVE cycle |
| amount | number | yes | ? 0.01, max 2 decimal places; must match the contribution exactly |
| transactionReference | string | yes | trimmed, non-empty, max 200 characters |
| paymentMethod | enum | no | `EASYPAISA`, `JAZZCASH`, `BANK_TRANSFER`, `OTHER`; omitted = null for backwards compatibility |

The backend stores the contribution's amount. Client-supplied status, ownership and
receipt paths are not accepted. Only one pending claim per contribution is allowed.
After rejection, create a new claim and upload a new receipt; historical evidence is retained.

**Example request:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/payments
Cookie: jwt=<token>
Content-Type: application/json
```

```json
{
  "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
  "amount": 5000,
  "transactionReference": "TRX-2026-1004",
  "paymentMethod": "EASYPAISA"
}
```

**Success response (`201`):**

```json
{
  "id": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
  "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
  "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "amount": "5000",
  "transactionReference": "TRX-2026-1004",
  "paymentMethod": "EASYPAISA",
  "status": "PENDING",
  "paidAt": "2026-10-03T09:45:00.000Z",
  "verifiedAt": null,
  "createdAt": "2026-10-03T09:45:00.000Z",
  "updatedAt": "2026-10-03T09:45:00.000Z",
  "receipt": null,
  "contribution": {
    "id": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
    "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "amount": "5000",
    "status": "PENDING",
    "cycle": {
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "status": "ACTIVE"
    },
    "member": {
      "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "role": "MEMBER",
      "status": "ACTIVE",
      "user": {
        "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "phone": "+92 300 1234567"
      }
    }
  }
}
```

`paidAt` is the claim-recorded timestamp inherited from the existing model, not proof
of receipt or a bank-confirmed transfer time. `verifiedAt` remains null until the admin
makes a decision. Amounts are serialised as decimal strings.

**Key errors:** `400` invalid body, amount mismatch, already paid or cycle not ACTIVE;
`401` unauthenticated; `403` missing active membership, another member's contribution
or wrong committee; `404` committee/contribution missing; `409` pending claim already exists.

### GET /committees/:committeeId/payments

List payments across the committee's cycles, newest first. Includes `paymentMethod`,
receipt metadata (or null), and the nested contribution shown in the creation response.
Receipt metadata does not grant access to its image.

**Auth:** Active Committee Member or Committee Creator.

**Request body:** None.

| Query parameter | Type | Default | Notes |
|---|---|---|---|
| status | `PENDING` / `VERIFIED` / `REJECTED` | ? | optional filter |
| page | integer ? 1 | 1 | |
| limit | integer ? 1 | 10 | |

**Example:** `GET /committees/:committeeId/payments?status=PENDING&page=1&limit=10`

**Success response (`200`):**

```json
{
  "data": [
    {
      "id": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
      "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
      "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "amount": "5000",
      "transactionReference": "TRX-2026-1004",
      "paymentMethod": "EASYPAISA",
      "status": "PENDING",
      "paidAt": "2026-10-03T09:45:00.000Z",
      "verifiedAt": null,
      "createdAt": "2026-10-03T09:45:00.000Z",
      "updatedAt": "2026-10-03T09:45:00.000Z",
      "receipt": null,
      "contribution": {
        "id": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
        "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
        "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
        "amount": "5000",
        "status": "PENDING",
        "cycle": {
          "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          "status": "ACTIVE"
        },
        "member": {
          "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
          "role": "MEMBER",
          "status": "ACTIVE",
          "user": {
            "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
            "name": "Ayesha Khan",
            "email": "ayesha@example.com",
            "phone": "+92 300 1234567"
          }
        }
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

**Key errors:** `401` unauthenticated; `403` no access; `404` committee missing.

### GET /committees/:committeeId/payments/:id

Get one payment, including its method, receipt metadata and contribution.

**Auth:** Active Committee Member or Committee Creator.

**Request body:** None.

**Success response (`200`):** The complete payment object shown in the creation
response; `receipt` contains metadata after upload.

**Key errors:** `401` unauthenticated; `403` no access or wrong committee;
`404` committee/payment missing.

### POST /committees/:committeeId/payments/:id/receipt

Attach one receipt image to a `PENDING` claim. The contribution must remain unpaid
and its cycle ACTIVE. Uploading does **not** verify the claim or change financial totals.
Receipts cannot be replaced or deleted through the API.

**Auth:** Paying Member with active committee membership or Committee Creator.

**Content-Type:** `multipart/form-data`

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| receipt | binary file | yes | one PNG or JPEG image, non-empty, maximum 5 MiB (5,242,880 bytes) |

No other fields or files are accepted. The backend checks MIME type and file signatures.
SVG, PDF and other formats are not supported. Original filenames are not stored or used
as storage paths.

**Example request:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/payments/c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f/receipt
Cookie: jwt=<token>
Content-Type: multipart/form-data; boundary=ReceiptBoundary

--ReceiptBoundary
Content-Disposition: form-data; name="receipt"; filename="receipt.png"
Content-Type: image/png

<binary PNG image bytes>
--ReceiptBoundary--
```

Browser example (let the browser set the multipart boundary):

```typescript
const form = new FormData();
form.append('receipt', file);
const response = await fetch(
  `${apiUrl}/committees/${committeeId}/payments/${paymentId}/receipt`,
  { method: 'POST', credentials: 'include', body: form },
);
const payment = await response.json();
```

**Success response (`201`):**

```json
{
  "id": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
  "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
  "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "amount": "5000",
  "transactionReference": "TRX-2026-1004",
  "paymentMethod": "EASYPAISA",
  "status": "PENDING",
  "paidAt": "2026-10-03T09:45:00.000Z",
  "verifiedAt": null,
  "createdAt": "2026-10-03T09:45:00.000Z",
  "updatedAt": "2026-10-03T09:45:00.000Z",
  "receipt": {
    "id": "e82d4f88-a3f6-4f92-9f31-fc6c6eac6cf6",
    "mimeType": "image/png",
    "size": 84213,
    "uploadedAt": "2026-10-03T09:46:00.000Z"
  },
  "contribution": {
    "id": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f",
    "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "amount": "5000",
    "status": "PENDING",
    "cycle": {
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "status": "ACTIVE"
    },
    "member": {
      "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "role": "MEMBER",
      "status": "ACTIVE",
      "user": {
        "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "phone": "+92 300 1234567"
      }
    }
  }
}
```

A `PAYMENT_RECEIPT_UPLOADED` audit record stores the actor, payment, receipt, committee
and cycle. Upload failure leaves the existing claim available for a retry.

**Key errors:** `400` missing/invalid image, unexpected multipart fields, non-PENDING
payment, paid contribution or inactive cycle; `401` unauthenticated;
`403` not the paying member/creator or wrong committee; `404` committee/payment missing;
`409` receipt already attached; `413` file too large; `500` storage failure.

Example validation error (`400`):

```json
{
  "message": "Receipt must be a PNG or JPEG image",
  "error": "Bad Request",
  "statusCode": 400
}
```

### GET /committees/:committeeId/payments/:id/receipt

Read the private receipt image, including receipts retained after approval or rejection.

**Auth:** Paying Member with active committee membership or Committee Creator.

**Request body:** None.

**Example request:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/payments/c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f/receipt
Cookie: jwt=<token>
```

**Success response (`200`):** Binary image bytes, **not JSON**.

```http
HTTP/1.1 200 OK
Content-Type: image/png
Content-Disposition: inline; filename="receipt.png"
Content-Length: 84213
Cache-Control: private, no-store
X-Content-Type-Options: nosniff

<binary PNG image bytes>
```

For JPEG, the content type is `image/jpeg` and filename is `receipt.jpg`.
For a dashboard preview, fetch with `credentials: 'include'`, read `response.blob()`,
create an object URL and revoke it when the preview is removed.

**Key errors:** `401` unauthenticated; `403` no receipt access or wrong committee;
`404` committee, payment, receipt or stored file missing; `500` storage read failure.

Example missing-receipt response (`404`):

```json
{
  "message": "Receipt not found",
  "error": "Not Found",
  "statusCode": 404
}
```

### POST /committees/:committeeId/payments/:id/verify

Approve a `PENDING` claim **after checking the receiving account's transaction history**.
A receipt is required, including for pending claims created before this feature.
The payment amount must match the contribution and the cycle must still be ACTIVE.

**Auth:** Platform ADMIN + Committee Creator.

**Request body:** None.

**Example:** `POST /committees/:committeeId/payments/:id/verify` with the admin JWT cookie.

Within one database transaction, approval marks the contribution `PAID`, links its
payment, increments the cycle total, marks the payment `VERIFIED`, and writes
`PAYMENT_VERIFIED`. The returned contribution reflects the updated paid status.
Competing decisions are serialised per contribution to prevent duplicate crediting.

**Success response (`200`):** Same complete object as the upload response, with these changes:

```json
{
  "status": "VERIFIED",
  "verifiedAt": "2026-10-03T11:00:00.000Z",
  "updatedAt": "2026-10-03T11:00:00.000Z",
  "contribution": {
    "status": "PAID"
  }
}
```

The member is notified after commit. A notification delivery failure is logged and
does not turn a committed payment into a failed HTTP operation.

**Key errors:** `400` payment not PENDING, missing receipt, amount mismatch or inactive
cycle; `401` unauthenticated; `403` not the platform admin/creator or wrong committee;
`404` committee/payment missing; `409` contribution already credited.

### POST /committees/:committeeId/payments/:id/reject

Reject a `PENDING` claim. A receipt is not required, so incomplete claims can be rejected.
Receipt evidence is retained and financial totals remain unchanged.

**Auth:** Platform ADMIN + Committee Creator.

**Request body:** None.

**Example:** `POST /committees/:committeeId/payments/:id/reject` with the admin JWT cookie.

**Success response (`200`):** Same complete payment object, with `status: "REJECTED"`
and updated `verifiedAt`/`updatedAt`; contribution status remains `PENDING` or `OVERDUE`.
The existing `verifiedAt` field records the admin decision time for both outcomes.

Rejection and its `PAYMENT_REJECTED` audit record are committed together. The member
is notified after commit. Resubmit using a new claim to preserve the old receipt and decision.

**Key errors:** `400` payment not PENDING; `401` unauthenticated;
`403` not the platform admin/creator or wrong committee; `404` committee/payment missing.



---

## Lottery

The backend exclusively determines lottery eligibility and winners. A member is
eligible for a cycle's draw when their contribution for that cycle is `PAID`, their
membership is `ACTIVE`, and they have not already received — or are not still awaiting —
a payout from an earlier cycle (a previous winner whose payout `FAILED` remains
eligible, because that member never received the pool). The winner is drawn with a
cryptographically strong Fisher–Yates shuffle (`crypto.randomInt`).

### GET /committees/:committeeId/cycles/:cycleId/lottery/eligibility

Check whether the cycle can run a lottery, with a reason when it cannot.

**Auth:** Committee Member

**Success response (`200`):**

| Field | Type | Notes |
|---|---|---|
| eligible | boolean | |
| reason | string \| null | why the cycle is not eligible; `null` when eligible |
| eligibleMemberCount | integer | `0` when not eligible |

**Key errors:** `403` no access · `404` committee or cycle not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/lottery/eligibility
Cookie: jwt=<token>
```

```json
{
  "eligible": true,
  "reason": null,
  "eligibleMemberCount": 3
}
```

### GET /committees/:committeeId/cycles/:cycleId/lottery/eligible-members

List the members eligible for this cycle's draw.

**Auth:** Committee Member

**Success response (`200`):** `{ data, total }` — each member is `{ id, role, status, user }`
(with `user` = `{ id, name, email, phone }`).

**Key errors:** `403` no access · `404` committee or cycle not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/lottery/eligible-members
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "a5b6c7d8-9e0f-4a1b-2c3d-4e5f6a7b8c9d",
      "role": "ADMIN",
      "status": "ACTIVE",
      "user": {
        "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
        "name": "Bilal Ahmed",
        "email": "bilal@example.com",
        "phone": null
      }
    },
    {
      "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "role": "MEMBER",
      "status": "ACTIVE",
      "user": {
        "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "phone": "+92 300 1234567"
      }
    },
    {
      "id": "15e6f7a8-9b0c-4d1e-2f3a-4b5c6d7e8f9a",
      "role": "MEMBER",
      "status": "ACTIVE",
      "user": {
        "id": "04d5e6f7-8a9b-4c0d-1e2f-3a4b5c6d7e8f",
        "name": "Usman Raza",
        "email": "usman@example.com",
        "phone": null
      }
    }
  ],
  "total": 3
}
```

### POST /committees/:committeeId/cycles/:cycleId/lottery/run

Run the draw. In a serializable transaction: the lottery result is created, the cycle
becomes `COMPLETED` (`endDate` = draw time), and a `LOTTERY_EXECUTED` audit entry is
written. All active members are then notified of the winner. A unique constraint on
`cycleId` makes double execution impossible even under concurrent calls.

**Auth:** Platform Admin + Committee Admin

**Success response (`201`):** lottery result with nested `cycle` and `winner`.

**Key errors:** `400` cycle not `ACTIVE`, or no eligible members (e.g. unpaid contributions) · `403` not committee admin · `404` committee or cycle not found · `409` lottery already executed for this cycle

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/lottery/run
Cookie: jwt=<admin-token>
```

Response (`201`):

```json
{
  "id": "d6e7f8a9-0b1c-4d2e-3f4a-5b6c7d8e9f0a",
  "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "winnerMemberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "eligibleMemberCount": 3,
  "executedAt": "2026-10-31T12:00:00.000Z",
  "executedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
  "createdAt": "2026-10-31T12:00:00.000Z",
  "cycle": {
    "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "cycleNumber": 1,
    "status": "COMPLETED"
  },
  "winner": {
    "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "role": "MEMBER",
    "status": "ACTIVE",
    "user": {
      "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "phone": "+92 300 1234567"
    }
  }
}
```

### GET /committees/:committeeId/cycles/:cycleId/lottery/result

Get the draw result for a cycle.

**Auth:** Committee Member

**Success response (`200`):** lottery result with nested `cycle` and `winner` (same shape as the run response).

**Key errors:** `403` no access · `404` committee or cycle not found, or no lottery result exists for this cycle

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/lottery/result
Cookie: jwt=<token>
```

Response (`200`): same result shape as shown for `POST .../lottery/run`.

### GET /committees/:committeeId/lotteries

List the committee's lottery history (one result per cycle), newest draw first.

**Auth:** Committee Member

**Success response (`200`):** `{ data, total }` — results with nested `cycle` and `winner`.

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/lotteries
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "d6e7f8a9-0b1c-4d2e-3f4a-5b6c7d8e9f0a",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "winnerMemberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "eligibleMemberCount": 3,
      "executedAt": "2026-10-31T12:00:00.000Z",
      "executedBy": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "createdAt": "2026-10-31T12:00:00.000Z",
      "cycle": {
        "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
        "cycleNumber": 1,
        "status": "COMPLETED"
      },
      "winner": {
        "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
        "role": "MEMBER",
        "status": "ACTIVE",
        "user": {
          "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
          "name": "Ayesha Khan",
          "email": "ayesha@example.com",
          "phone": "+92 300 1234567"
        }
      }
    }
  ],
  "total": 1
}
```

---

## Payouts

A payout hands a cycle's collected pool to its lottery winner. The payout amount is
exclusively determined by the backend (the cycle's `totalCollected`) and the recipient
is taken from the persisted lottery result — never from client input. Status follows a
state machine: `PENDING → PROCESSING → COMPLETED | FAILED`, with `FAILED → PROCESSING`
retry allowed; `COMPLETED` is final and immutable.

Payout routes live under **three controllers** — note the singular `/payout` in the
cycle-scoped paths, and that `/my-payouts` is rooted at the API base.

### POST /committees/:committeeId/cycles/:cycleId/payout

Create the payout for a cycle that has a lottery winner. Amount = the cycle's collected
pool; recipient = the cycle's lottery winner. Records a `PAYOUT_CREATED` audit entry.

**Auth:** Platform Admin + Committee Admin

**Success response (`201`):** payout with nested `cycle` and `member` (incl. `member.user`).

**Key errors:** `400` no lottery result exists for the cycle, or the cycle has no collected funds · `403` not committee admin · `404` committee or cycle not found · `409` a payout already exists for this cycle

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/payout
Cookie: jwt=<admin-token>
```

Response (`201`):

```json
{
  "id": "e7f8a9b0-1c2d-4e3f-4a5b-6c7d8e9f0a1b",
  "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "amount": "15000.00",
  "status": "PENDING",
  "paidAt": null,
  "reference": null,
  "createdAt": "2026-10-31T12:30:00.000Z",
  "updatedAt": "2026-10-31T12:30:00.000Z",
  "cycle": {
    "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "cycleNumber": 1,
    "status": "COMPLETED"
  },
  "member": {
    "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "role": "MEMBER",
    "status": "ACTIVE",
    "user": {
      "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "phone": "+92 300 1234567"
    }
  }
}
```

### GET /committees/:committeeId/cycles/:cycleId/payout

Get the payout for a cycle.

**Auth:** Committee Member

**Success response (`200`):** payout with nested `cycle` and `member` (same shape as the POST response).

**Key errors:** `403` no access · `404` committee or cycle not found, or no payout exists for this cycle

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/payout
Cookie: jwt=<token>
```

Response (`200`): same payout shape as shown above.

### PATCH /committees/:committeeId/cycles/:cycleId/payout/:id/status

Move a payout through its status state machine. Transitioning to `COMPLETED` stamps
`paidAt` and notifies the winner. Records a `PAYOUT_STATUS_CHANGED` audit entry.

**Auth:** Platform Admin + Committee Admin

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| status | string | yes | `PROCESSING` \| `COMPLETED` \| `FAILED`; must be a valid transition from the current status |
| reference | string | no | ≤ 255 chars; payout reference (e.g. bank transfer number) |

Valid transitions: `PENDING → PROCESSING`, `PROCESSING → COMPLETED \| FAILED`,
`FAILED → PROCESSING`. `COMPLETED` has no outgoing transitions.

**Success response (`200`):** updated payout with nested `cycle` and `member`.

**Key errors:** `400` invalid transition for the current status · `403` not committee admin, or payout belongs to another committee · `404` committee or payout not found

**Example:**

```http
PATCH /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/cycles/f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c/payout/e7f8a9b0-1c2d-4e3f-4a5b-6c7d8e9f0a1b/status
Cookie: jwt=<admin-token>
```

```json
{ "status": "COMPLETED", "reference": "BANK-TRF-2026-1001" }
```

Response (`200`):

```json
{
  "id": "e7f8a9b0-1c2d-4e3f-4a5b-6c7d8e9f0a1b",
  "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
  "amount": "15000.00",
  "status": "COMPLETED",
  "paidAt": "2026-11-01T09:00:00.000Z",
  "reference": "BANK-TRF-2026-1001",
  "createdAt": "2026-10-31T12:30:00.000Z",
  "updatedAt": "2026-11-01T09:00:00.000Z",
  "cycle": {
    "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "cycleNumber": 1,
    "status": "COMPLETED"
  },
  "member": {
    "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
    "role": "MEMBER",
    "status": "ACTIVE",
    "user": {
      "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "phone": "+92 300 1234567"
    }
  }
}
```

### GET /committees/:committeeId/payouts

List all payouts of a committee, newest first.

**Auth:** Committee Member

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| status | enum `PayoutStatus` (`PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED`) | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 10 | |

**Success response (`200`):** pagination envelope of payouts with nested `cycle` and `member`.

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/payouts?status=COMPLETED&page=1&limit=10
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "e7f8a9b0-1c2d-4e3f-4a5b-6c7d8e9f0a1b",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "amount": "15000.00",
      "status": "COMPLETED",
      "paidAt": "2026-11-01T09:00:00.000Z",
      "reference": "BANK-TRF-2026-1001",
      "createdAt": "2026-10-31T12:30:00.000Z",
      "updatedAt": "2026-11-01T09:00:00.000Z",
      "cycle": {
        "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
        "cycleNumber": 1,
        "status": "COMPLETED"
      },
      "member": {
        "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
        "role": "MEMBER",
        "status": "ACTIVE",
        "user": {
          "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
          "name": "Ayesha Khan",
          "email": "ayesha@example.com",
          "phone": "+92 300 1234567"
        }
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

### GET /my-payouts

List the authenticated member's own payouts across all their committees, newest first.
The nested `cycle` additionally includes `committeeId`.

**Auth:** User

**Success response (`200`):** `{ data, total }` — payouts with nested `cycle` and `member`.

**Key errors:** — (authenticated user; empty list when none)

**Example:**

```http
GET /my-payouts
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "e7f8a9b0-1c2d-4e3f-4a5b-6c7d8e9f0a1b",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "memberId": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
      "amount": "15000.00",
      "status": "COMPLETED",
      "paidAt": "2026-11-01T09:00:00.000Z",
      "reference": "BANK-TRF-2026-1001",
      "createdAt": "2026-10-31T12:30:00.000Z",
      "updatedAt": "2026-11-01T09:00:00.000Z",
      "cycle": {
        "id": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
        "cycleNumber": 1,
        "status": "COMPLETED",
        "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
      },
      "member": {
        "id": "d0e1f2a3-4b5c-4d6e-8f9a-0b1c2d3e4f5a",
        "role": "MEMBER",
        "status": "ACTIVE",
        "user": {
          "id": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
          "name": "Ayesha Khan",
          "email": "ayesha@example.com",
          "phone": "+92 300 1234567"
        }
      }
    }
  ],
  "total": 1
}
```

---

## Audit Trail

Every important change is recorded as an immutable audit entry (see the audit actions
in [Enum Reference](#enum-reference)). Audit endpoints are readable by any committee
member; entries are created by the backend alongside the operations they describe,
atomically where possible.

### GET /committees/:committeeId/audit-logs

List a committee's audit entries, newest first.

**Auth:** Committee Member

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| action | enum `AuditAction` | — | filter (12 values; see Enum Reference) |
| entityType | string | — | filter (e.g. `Committee`, `Payment`, `LotteryResult`) |
| cycleId | string | — | filter |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 25 | note the higher default |

**Success response (`200`):** pagination envelope of audit entries.

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/audit-logs?action=PAYMENT_VERIFIED&page=1&limit=25
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "f1a2b3c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "actorId": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "action": "PAYMENT_VERIFIED",
      "entityType": "Payment",
      "entityId": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "metadata": { "amount": 5000, "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f" },
      "createdAt": "2026-10-03T11:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 25
}
```

### GET /committees/:committeeId/audit-logs/timeline

The committee's full audit history in chronological order (oldest first). Useful for
rendering a visual timeline.

**Auth:** Committee Member

**Success response (`200`):** `{ data, total }` — all entries (no pagination).

**Key errors:** `403` no access · `404` committee not found

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/audit-logs/timeline
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "actorId": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "action": "COMMITTEE_CREATED",
      "entityType": "Committee",
      "entityId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleId": null,
      "metadata": null,
      "createdAt": "2026-09-04T10:00:00.000Z"
    },
    {
      "id": "f1a2b3c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "actorId": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4e",
      "action": "PAYMENT_VERIFIED",
      "entityType": "Payment",
      "entityId": "c5d6e7f8-9a0b-4c1d-2e3f-4a5b6c7d8e9f",
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "metadata": { "amount": 5000, "contributionId": "c6d7e8f9-0a1b-4c2d-3e4f-5a6b7c8d9e0f" },
      "createdAt": "2026-10-03T11:00:00.000Z"
    }
  ],
  "total": 2
}
```

---

## Notifications

In-app notifications for each user. Most are generated by the backend (payment verified,
lottery completed, payout completed, invitation, scheduled reminders). Committee admins
can also broadcast a notification to their committee.

### GET /notifications

List the authenticated user's notifications, newest first.

**Auth:** User

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| type | enum `NotificationType` | — | filter (11 values; see Enum Reference) |
| read | boolean | — | filter (`true`/`false`) |
| page | integer ≥ 1 | 1 | |
| limit | integer ≥ 1 | 20 | |

**Success response (`200`):** `{ data, total, unreadCount, page, limit }` — `unreadCount`
counts ALL unread notifications, ignoring the filters.

**Key errors:** — (authenticated user; empty list when none)

**Example:**

```http
GET /notifications?read=false&page=1&limit=20
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "id": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      "userId": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
      "type": "COMMITTEE_INVITATION",
      "title": "Committee Invitation",
      "message": "You have been invited to join \"Savings Committee\". Click to accept.",
      "read": false,
      "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "token": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "createdAt": "2026-10-03T11:00:00.000Z"
    }
  ],
  "total": 1,
  "unreadCount": 1,
  "page": 1,
  "limit": 20
}
```

**Notes:**
- The `token` field is only populated for `COMMITTEE_INVITATION` notifications. It contains the invitation acceptance token, allowing the frontend to deep-link to `/invitations/accept?token=<value>`. For all other notification types, `token` is `null`.

### GET /notifications/unread-count

Count the authenticated user's unread notifications.

**Auth:** User

**Success response (`200`):** `{ "count": <number> }`

**Example:**

```http
GET /notifications/unread-count
Cookie: jwt=<token>
```

```json
{ "count": 1 }
```

### PATCH /notifications/:id/read

Mark one notification as read.

**Auth:** User (owner only)

**Success response (`200`):** the updated notification (`read: true`).

**Key errors:** `403` not the notification's owner · `404` notification not found

**Example:**

```http
PATCH /notifications/b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e/read
Cookie: jwt=<token>
```

```json
{
  "id": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  "userId": "b1f3c2a4-5d6e-4f7a-8b9c-0d1e2f3a4b5c",
  "type": "PAYMENT_VERIFIED",
  "title": "Payment Verified",
  "message": "Your payment of 5000 has been verified.",
  "read": true,
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "token": null,
  "createdAt": "2026-10-03T11:00:00.000Z"
}
```

### PATCH /notifications/read-all

Mark all of the authenticated user's notifications as read.

**Auth:** User

**Success response (`200`):** `{ "count": <number updated> }`

**Example:**

```http
PATCH /notifications/read-all
Cookie: jwt=<token>
```

```json
{ "count": 3 }
```

### POST /committees/:committeeId/notifications

Broadcast a notification to all `ACTIVE` and `INVITED` members of a committee, plus the
committee admin. Authorization is an internal creator check (not `AdminGuard` — see
[Notes and Known Ambiguities](#notes-and-known-ambiguities)).

**Auth:** User (must be the committee's creator)

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| type | string | no | enum `NotificationType`; default `GENERAL` |
| title | string | yes | non-empty, ≤ 255 chars |
| message | string | yes | non-empty, ≤ 2000 chars |

**Success response (`201`):** `{ "sent": <recipient count> }`

**Key errors:** `403` requester is not the committee admin · `404` committee not found

**Example:**

```http
POST /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/notifications
Cookie: jwt=<admin-token>
```

```json
{
  "type": "GENERAL",
  "title": "November draw approaching",
  "message": "Please submit your October payment evidence before the 5th so the lottery can run on time."
}
```

Response (`201`):

```json
{ "sent": 4 }
```

---

## Reports

Read-only analytical reports per committee, at
`/committees/:committeeId/reports/...`. All reports are accessible to any committee
member. Every JSON report also has a `/csv` variant that returns the same rows as a
`text/csv` attachment (filenames noted per report); CSV endpoints accept the same query
params and enforce the same access rules. Unless noted otherwise, money values are
plain numbers.

Common query params (apply to all reports that accept them):

| Param | Type | Default | Notes |
|---|---|---|---|
| cycleId | UUID string | — | restrict to one cycle |
| status | string | — | only meaningful for `outstanding` (see below) |
| page | integer ≥ 1 | 1 | only `outstanding` paginates |
| limit | integer ≥ 1 | 50 (outstanding) | only `outstanding` paginates |

### GET /committees/:committeeId/reports/summary

Committee overview: configuration, member counts, cycle counts.

**Auth:** Committee Member

**Success response (`200`):**

| Field | Type | Notes |
|---|---|---|
| committeeId | UUID | |
| name | string | |
| description | string \| null | |
| status | enum `CommitteeStatus` | |
| contributionAmount | number | |
| memberLimit | integer | |
| totalCycles | integer | configured cycle count |
| dueDay | integer | |
| startDate | ISO date | |
| createdBy | string | creator's **name** |
| createdAt | ISO datetime | |
| memberCount | integer | |
| activeMemberCount | integer | |
| cycleCount | integer | cycles created so far |
| completedCycleCount | integer | |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/summary/csv` → `committee-summary.csv` (single row).

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/summary
Cookie: jwt=<token>
```

```json
{
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "name": "Friday Kameti",
  "description": "Monthly rotating savings group",
  "status": "ACTIVE",
  "contributionAmount": 5000,
  "memberLimit": 10,
  "totalCycles": 10,
  "dueDay": 5,
  "startDate": "2026-10-01T00:00:00.000Z",
  "createdBy": "Bilal Ahmed",
  "createdAt": "2026-09-04T10:00:00.000Z",
  "memberCount": 3,
  "activeMemberCount": 3,
  "cycleCount": 10,
  "completedCycleCount": 1
}
```

### GET /committees/:committeeId/reports/contributions

Per-cycle contribution and collection breakdown, ordered by cycle number.

**Auth:** Committee Member

**Query params:** `cycleId`, (see common params)

**Success response (`200`):** `{ data }` — per cycle:

| Field | Type | Notes |
|---|---|---|
| cycleId | UUID | |
| cycleNumber | integer | |
| cycleStatus | enum `CycleStatus` | |
| totalExpected | number | sum of contribution records |
| totalCollected | number | from the cycle record |
| totalPaid | number | sum of `PAID` contribution amounts |
| contributionCount | integer | |
| paidCount | integer | |
| pendingCount | integer | |
| overdueCount | integer | |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/contributions/csv` → `contribution-summary.csv`.

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/contributions?cycleId=f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "cycleNumber": 1,
      "cycleStatus": "COMPLETED",
      "totalExpected": 15000,
      "totalCollected": 15000,
      "totalPaid": 15000,
      "contributionCount": 3,
      "paidCount": 3,
      "pendingCount": 0,
      "overdueCount": 0
    }
  ]
}
```

### GET /committees/:committeeId/reports/outstanding

Members with `PENDING` or `OVERDUE` contributions, ordered by due date (soonest first).
This is the only paginated report (default limit 50).

**Auth:** Committee Member

**Query params:** `cycleId`, `status` (only `PENDING` or `OVERDUE` narrow the filter;
other values are ignored and both statuses are returned), `page`, `limit`

**Success response (`200`):** `{ data, total, page, limit }` — per contribution:

| Field | Type | Notes |
|---|---|---|
| contributionId | UUID | |
| memberId | UUID | |
| memberName | string | |
| memberEmail | string | |
| memberStatus | enum `MemberStatus` | |
| cycleNumber | integer | |
| cycleStatus | enum `CycleStatus` | |
| amount | number | |
| status | `PENDING` \| `OVERDUE` | |
| dueDate | ISO datetime | |
| daysOverdue | integer | `0` unless `OVERDUE` |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/outstanding/csv` → `outstanding-payments.csv`.

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/outstanding?page=1&limit=50
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "contributionId": "d7e8f9a0-1b2c-4d3e-4f5a-6b7c8d9e0f1a",
      "memberId": "15e6f7a8-9b0c-4d1e-2f3a-4b5c6d7e8f9a",
      "memberName": "Usman Raza",
      "memberEmail": "usman@example.com",
      "memberStatus": "ACTIVE",
      "cycleNumber": 1,
      "cycleStatus": "COMPLETED",
      "amount": 5000,
      "status": "OVERDUE",
      "dueDate": "2026-10-05T23:59:59.000Z",
      "daysOverdue": 12
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

### GET /committees/:committeeId/reports/cycles

Per-cycle completion status, dates, and collection rate, ordered by cycle number.

**Auth:** Committee Member

**Query params:** `cycleId`, (see common params)

**Success response (`200`):** `{ data }` — per cycle:

| Field | Type | Notes |
|---|---|---|
| cycleId | UUID | |
| cycleNumber | integer | |
| status | enum `CycleStatus` | |
| startDate | ISO datetime \| null | |
| endDate | ISO datetime \| null | |
| totalExpected | number | |
| totalCollected | number | |
| totalContributions | integer | |
| paidContributions | integer | |
| collectionRatePercent | integer | `round(paid / total × 100)`, `0` when no contributions |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/cycles/csv` → `cycle-completion-summary.csv`.

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/cycles
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "cycleNumber": 1,
      "status": "COMPLETED",
      "startDate": "2026-10-01T00:00:00.000Z",
      "endDate": "2026-10-31T12:00:00.000Z",
      "totalExpected": 15000,
      "totalCollected": 15000,
      "totalContributions": 3,
      "paidContributions": 3,
      "collectionRatePercent": 100
    }
  ]
}
```

### GET /committees/:committeeId/reports/lottery-payouts

Per-cycle lottery and payout status, ordered by cycle number.

**Auth:** Committee Member

**Query params:** `cycleId`, (see common params)

**Success response (`200`):** `{ data }` — per cycle:

| Field | Type | Notes |
|---|---|---|
| cycleId | UUID | |
| cycleNumber | integer | |
| cycleStatus | enum `CycleStatus` | |
| totalCollected | number | |
| lotteryExecuted | boolean | |
| lotteryExecutedAt | ISO datetime \| null | |
| eligibleMemberCount | integer | `0` when no lottery |
| winnerName | string \| null | |
| winnerEmail | string \| null | |
| payoutCreated | boolean | |
| payoutAmount | number | `0` when no payout |
| payoutStatus | enum `PayoutStatus` \| null | |
| payoutPaidAt | ISO datetime \| null | |
| payoutReference | string \| null | |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/lottery-payouts/csv` → `lottery-payout-summary.csv`.

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/lottery-payouts
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "cycleId": "f2a3b4c5-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
      "cycleNumber": 1,
      "cycleStatus": "COMPLETED",
      "totalCollected": 15000,
      "lotteryExecuted": true,
      "lotteryExecutedAt": "2026-10-31T12:00:00.000Z",
      "eligibleMemberCount": 3,
      "winnerName": "Ayesha Khan",
      "winnerEmail": "ayesha@example.com",
      "payoutCreated": true,
      "payoutAmount": 15000,
      "payoutStatus": "COMPLETED",
      "payoutPaidAt": "2026-11-01T09:00:00.000Z",
      "payoutReference": "BANK-TRF-2026-1001"
    }
  ]
}
```

### GET /committees/:committeeId/reports/members

Per-member participation summary, ordered by join date.

**Auth:** Committee Member

**Query params:** `cycleId` (restricts contribution counts to one cycle), (see common params)

**Success response (`200`):** `{ data }` — per member:

| Field | Type | Notes |
|---|---|---|
| memberId | UUID | |
| memberName | string | |
| memberEmail | string | |
| memberStatus | enum `MemberStatus` | |
| memberRole | enum `MemberRole` | |
| joinedAt | ISO datetime | |
| totalCycles | integer | contribution records |
| paidCycles | integer | |
| pendingCycles | integer | |
| overdueCycles | integer | |
| totalAmountContributed | number | sum of `PAID` contributions |
| totalAmountPaid | number | sum of `VERIFIED` payments |
| lotteryWins | integer | |
| totalPayoutReceived | number | sum of `COMPLETED` payouts |

**Key errors:** `403` no access · `404` committee not found

CSV variant: `GET .../reports/members/csv` → `member-participation-summary.csv`.

**Example:**

```http
GET /committees/c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d/reports/members
Cookie: jwt=<token>
```

```json
{
  "data": [
    {
      "memberId": "a5b6c7d8-9e0f-4a1b-2c3d-4e5f6a7b8c9d",
      "memberName": "Bilal Ahmed",
      "memberEmail": "bilal@example.com",
      "memberStatus": "ACTIVE",
      "memberRole": "ADMIN",
      "joinedAt": "2026-09-04T10:00:00.000Z",
      "totalCycles": 1,
      "paidCycles": 1,
      "pendingCycles": 0,
      "overdueCycles": 0,
      "totalAmountContributed": 5000,
      "totalAmountPaid": 5000,
      "lotteryWins": 0,
      "totalPayoutReceived": 0
    }
  ]
}
```

---

## AI Committee Assistant

### POST /ai/assistant

Ask a natural-language question about the requester's committees. The backend builds a
JSON context of the user's committees (financials, members, cycles, payments, lottery
results, payouts), and an LLM answers strictly from that context — it never makes
financial decisions or predicts lottery outcomes. Without `committeeId`, the context
covers committees the user created or is a non-`REMOVED` member of, capped at the 5 most
recent (the answer notes when truncated). Users with no committees get a canned reply
without calling the AI provider.

**Auth:** User

**Request body:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| question | string | yes | 3–500 chars |
| committeeId | UUID string | no | restrict context to one committee |

**Success response (`201`):** `{ "answer": "<string>" }`

**Key errors:** `403` no access to the specified committee · `404` committee not found · `503` AI provider unconfigured, timed out, or otherwise unavailable

**Example:**

```http
POST /ai/assistant
Cookie: jwt=<token>
```

```json
{
  "question": "How much have I contributed so far and when is my next payment due?",
  "committeeId": "c9a1b2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
}
```

Response (`201`):

```json
{
  "answer": "You have contributed 5000 so far, covering cycle 1. Your next contribution of 5000 is due on 2026-11-05."
}
```

---

## Background Jobs

These are not HTTP endpoints — they run automatically once the server (and Redis) is up.

**Daily 9 AM — contribution reminders** (`@Cron(EVERY_DAY_AT_9AM)`): finds `PENDING`
contributions due within the next 3 days, groups them per user, and enqueues a
`CONTRIBUTION_REMINDER` notification per user. Jobs are deduplicated per user per day
(`reminder-<userId>-<date>`), so a user gets at most one reminder daily.

**Daily 10 AM — overdue sweep** (`@Cron(EVERY_DAY_AT_10AM)`): finds `PENDING`
contributions past their due date whose cycle is `ACTIVE` or `UPCOMING`, flips them to
`OVERDUE`, and enqueues a consolidated `CONTRIBUTION_OVERDUE` notification per user
(deduplicated per user per day).

**BullMQ queue `notifications`**: a processor consumes `send` jobs (fan-out to a list of
`userIds`) and `send-single` jobs (one `userId`), persisting the notifications. Redis
connection comes from `REDIS_HOST`/`REDIS_PORT` (defaults `localhost:6379`).

---

## Enum Reference

All values as defined in `prisma/schema.prisma`.

| Enum | Values |
|---|---|
| `UserRole` | `USER` \| `ADMIN` |
| `UserStatus` | `ACTIVE` \| `INACTIVE` \| `SUSPENDED` |
| `CommitteeStatus` | `DRAFT` \| `ACTIVE` \| `PAUSED` \| `COMPLETED` \| `CANCELLED` |
| `PayoutMethod` | `LOTTERY` |
| `MemberRole` | `ADMIN` \| `MEMBER` |
| `MemberStatus` | `ACTIVE` \| `INACTIVE` \| `INVITED` \| `REMOVED` |
| `InvitationStatus` | `PENDING` \| `ACCEPTED` \| `EXPIRED` \| `CANCELLED` |
| `CycleStatus` | `UPCOMING` \| `ACTIVE` \| `COMPLETED` \| `CANCELLED` |
| `ContributionStatus` | `PENDING` \| `PAID` \| `OVERDUE` |
| `PaymentStatus` | `PENDING` \| `VERIFIED` \| `REJECTED` |
| `PayoutStatus` | `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` |
| `AuditAction` | `COMMITTEE_CREATED` \| `COMMITTEE_UPDATED` \| `COMMITTEE_STATUS_CHANGED` \| `MEMBER_INVITED` \| `MEMBER_JOINED` \| `MEMBER_REMOVED` \| `PAYMENT_VERIFIED` \| `PAYMENT_REJECTED` \| `CONTRIBUTION_STATUS_CHANGED` \| `LOTTERY_EXECUTED` \| `PAYOUT_CREATED` \| `PAYOUT_STATUS_CHANGED` |
| `NotificationType` | `COMMITTEE_INVITATION` \| `COMMITTEE_STATUS_CHANGED` \| `CYCLE_STARTED` \| `CYCLE_COMPLETED` \| `CONTRIBUTION_REMINDER` \| `CONTRIBUTION_OVERDUE` \| `PAYMENT_VERIFIED` \| `PAYMENT_REJECTED` \| `LOTTERY_COMPLETED` \| `PAYOUT_COMPLETED` \| `GENERAL` |

---

## Notes and Known Ambiguities

Behaviors that are accurate to the code but may be surprising, flagged per the
documentation mandate:

1. **Committee CRUD is platform-ADMIN only.** `CommitteesController` applies
   `AdminGuard` at the class level, so creating, reading, updating, or deleting
   committees requires the platform `ADMIN` role — and `GET /committees` lists only
   committees the admin **created** (not committees they merely joined). Regular users
   see their committees via `GET /committees/my-committees`.
2. **`my-committees` vs `:id` route ordering.** `GET /committees/my-committees` works
   only because `MembersModule` is registered before `CommitteesModule` in
   `app.module.ts`; otherwise `my-committees` would match the `:id` route.
3. **Payment verify/reject take no body.** `VerifyPaymentDto` exists but is unused —
   `POST .../payments/:id/verify` and `.../reject` read nothing from the request body.
4. **`CreateNotificationDto` is unused.** Only `SendCommitteeNotificationDto` is bound
   by the admin broadcast endpoint; `CreateNotificationDto` is dead code.
5. **`src/lotteries/dto/` is an empty folder.** No DTOs exist for lottery endpoints.
6. **`PORT` and `CORS_ORIGIN` are not in `.env.example`.** `main.ts` reads them with
   defaults (`3000`, `http://localhost:3000`), but the sample env file omits them.
7. **Invitation acceptance requires email match and ACTIVE committee.** The accepting
   user's email must match the invitation's email, and the committee must be `ACTIVE`.
   Invitations to `DRAFT`, `PAUSED`, `COMPLETED`, or `CANCELLED` committees are rejected.
8. **Admin notification broadcast uses an internal creator check, not `AdminGuard`.**
   A platform admin who did not create the committee gets `403` from
   `POST /committees/:committeeId/notifications`.
9. **No seed script exists.** There is no `prisma/seed.ts` or seed npm script; the
   database starts empty after migrations.

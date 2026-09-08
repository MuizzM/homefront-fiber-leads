# SQLite identity admission and Homefront MFA core

This module checkpoint is isolated from production migration startup and HTTP authentication. It provides tested transaction primitives; SAML/OIDC/SCIM adapters, current-session integration, public API contracts and login/admin/profile screens remain required before activation. Importing the modules does not configure an identity provider or create a production secret.

## Confirmed behavior

- New enterprise identities are tenant-bound, least-privilege login accounts requiring tenant-admin approval. Provisioning never adopts an existing email, including same-tenant or unowned legacy accounts.
- Directory disable/delete and reactivation advance the lifecycle generation and clear approval. Approval applies only to the displayed generation. Local offboarding remains independent; approval and directory reactivation never change roster, training, pay or `users.active`.
- Tenant-required MFA means verified Homefront TOTP, passkey or recovery evidence. IdP claims and SMS evidence do not satisfy that requirement. Voluntarily enrolled Homefront MFA also requires verification.
- A full session limit refuses new admission and preserves existing sessions. The current browser can retry final admission after explicit session revocation without resubmitting a consumed MFA code.
- Existing policy must constrain session reads and renewal as well as new admission. Default field lifetimes remain seven days idle/thirty days absolute unless configured globally. The current core exposes policy evaluation; production read/renewal wiring is not yet active.

## Transaction interfaces

All synchronous mutations require a caller-owned writer transaction, normally `interactiveTransaction`. The migration acquires `BEGIN IMMEDIATE` before prerequisite reads and DDL. Provider I/O and asynchronous passkey cryptography occur outside the writer transaction.

| Interface | Required caller authority and result |
| --- | --- |
| `provisionManagedAccount` | A verified connection's persisted tenant; creates a new pending rep only, or an explicit email-link conflict. |
| `transitionDirectoryAccount` | An authenticated directory resource's persisted tenant/user and expected generation; idempotent identical updates, fresh approval on lifecycle changes. |
| `reviewManagedAccount` | Current administrator session, explicit tenant and expected target generation; rechecks authority after acquiring the writer. |
| `bindIdentityOtp` / `identityOtpCurrent` | Bind during issuance to user/tenant/epoch; verify binding before consuming a matching code. Unchanged legacy accounts alone may use older unbound codes. |
| `continueVerifiedIdentity` | Primary proof verified and consumed in the same transaction; returns a browser-bound continuation or a typed denial. It must never be exposed as a user-id login API. |
| `admitIdentityContinuation` | Continuation and browser secret; checks current account/policy/MFA/capacity, then atomically consumes proof and creates session assurance. |
| TOTP and recovery functions | Current browser continuation; existing MFA required to replace factors or regenerate recovery codes. Failed verification returns a result so its attempt count commits. |
| Passkey ceremony functions | Current browser continuation and fixed operator realm; pre-crypto budget reservation and post-crypto revalidation/CAS. |

Final admission returns `authenticated`, `mfa_required`, `session_limit`, or `denied`. Pending approval and directory/account restrictions have distinct codes. A pending-flow limit includes its earliest retry time. A deliberately restarted, freshly verified primary login replaces this browser's older continuation; it does not cancel other browsers.

A continuation expires ten minutes after primary verification. Factor enrollment and session-limit retries preserve that original deadline. Passkey ceremonies have a separate five-minute deadline. A successful admission creates a browser-bound completion receipt for at most two minutes, capped by the original continuation expiry. A retry returns the same session only while its current authority remains valid, without a new session or renewal. Revocation also removes that receipt through the session foreign key.

## Factors and recovery

TOTP secrets use AES-256-GCM with authenticated tenant, owner, purpose and secret revision. Enrollment secrets have a separate owner context from active factors. `IDENTITY_ENCRYPTION_KEYS` is an operator-supplied mapping of key IDs to 32-byte hex keys; `IDENTITY_ENCRYPTION_ACTIVE_KEY_ID` selects writes. Missing/malformed keys fail closed. Retained key IDs permit deliberate rotation. No fallback development key is provided by these modules.

TOTP verification uses otplib's exclusive `afterTimeStep` replay bound inside the writer transaction. Each account has a durable ten-failure/fifteen-minute budget shared across continuations. Recovery codes contain 256 random bits and are stored hashed; eight are returned at first enrollment. They are consumed once. Recovery rotation revokes older sessions/proofs and preserves only the current verified browser flow.

Passkeys use SimpleWebAuthn, ES256/RS256, user presence and local user verification. `IDENTITY_WEBAUTHN_ORIGIN` and `IDENTITY_WEBAUTHN_RP_ID` are operator configuration, never request-header-derived. Cross-origin or top-origin ceremonies are unsupported and rejected explicitly. Counter-zero authenticators are supported; challenge consumption and credential revisions still prevent same-ceremony replay. Credential ownership, realm, key, counter and revision are checked again when committing an asynchronous verification. A separate per-user ten-verification/minute reservation bounds concurrent crypto work before it begins. Responses are bounded to 64 KiB and client-data JSON to 8 KiB.

Initial passkey enrollment supplies recovery codes; adding another passkey preserves existing codes. Factor changes revoke prior authority. The enrolling continuation alone is restored with the current epoch and freshly verified MFA. The eventual UI must show this session consequence and support owner-bound pending field-work recovery. Do not persist continuations as application session IDs or offline user snapshots.

## Persistence and operations

Managed anchors cannot be deleted or retargeted through generic user/team paths. Security epochs and MFA revisions cannot be reset/deleted while their user exists. Directory transitions must clear approval and advance the generation at the SQL boundary. MFA-enrolled account tenant transfer is rejected because secret/realm ownership is bound to the original account context.

Migration tests cover legacy preservation, fresh install, repeated install, other connections, native backup/restore, failed prerequisites, partial DDL rollback and repair/retry. Lifecycle audit failures roll back state and revocation. Session-cap contention uses independent processes waiting behind a held writer. Tests use synthetic accounts, authenticator keys and local browser assets only.

The admission capacity query uses the user/expiry expression index and joins assurance in one bounded read. More than 500 unexpired legacy candidates causes conservative refusal rather than an unbounded scan or overflow. Completion-receipt expiry cleanup is indexed and capped at 100 rows per successful admission. Ordinary status/stream reads must remain non-renewing when this core is integrated.

Additive tables do not make old application binaries safe after activation: they ignore approval and MFA policy. Before enabling any enterprise configuration, upgrade all workers, establish a minimum compatible rollback image, validate an encrypted representative backup/restore, and complete the existing staging/canary gates. No production activation is authorized by isolated module tests.

Primary implementation references: [otplib replay protection](https://otplib.yeojz.dev/guide/advanced-usage), [SimpleWebAuthn server verification](https://simplewebauthn.dev/docs/packages/server).

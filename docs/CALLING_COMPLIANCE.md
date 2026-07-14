# Calling compliance runbook

Status: dark launch only. Last reviewed: 2026-07-14.

This document describes engineering controls, not legal advice. Telemarketing law is fact- and jurisdiction-specific. Home Front Solutions must obtain written approval from qualified counsel for the seller, offer, states, scripts, consent language, registrations/exemptions, vendor contracts, caller ID, and DNC process before enabling a tenant. Product controls reduce risk; they do not establish legal compliance.

## Safety posture

Calling is a separate capability domain from Field Map. A field rep, generic `rep`, scan result, lead phone field, or URL cannot authorize a call. Full numbers remain encrypted and masked until a specifically authorized Calling rep takes an explicit manual action. The server then recomputes every rule and issues a short-lived, single-use authorization bound to tenant, user, lead, contact, phone, rule version, and action.

The system is fail-closed:

- Calling, enrichment, federal DNC, state rules, and manual click-to-call flags default off.
- The emergency stop defaults on unless `CALLING_EMERGENCY_DISABLED=false` is explicitly set.
- Only organization IDs in `CALLING_PILOT_ORG_IDS` can participate.
- Missing encryption/signing keys, contract approval, seller authorization, state registration or documented exemption, counsel approval, approved script, active rules, caller ID approval, phone validation, high-confidence identity match, current DNC data, or reliable timezone blocks authorization.
- Entity-specific opt-out and consent revocation have precedence over every other verdict.
- No batch reveal, preview/predictive dialer, autodial, prerecorded voice, artificial voice, ringless voicemail, or SMS workflow exists.
- Wireless is recorded in the rule evidence and is callable only after an explicit human manual action. An automated attempt returns `BLOCKED_AUTOMATED_DIAL_ATTEMPT`.
- The server never automatically advances to or dials the next record.

### Current pilot boundary

This is an NC/SC dark-launch implementation, not an all-50-state calling system. The current timezone resolver gives high-confidence address-local time only for North Carolina and South Carolina. Other states remain fail-closed even if an administrator adds them to a rule. Expanding beyond NC/SC requires a tested address-level timezone resolver, state-specific counsel approval, active registration or documented exemption, applicable state DNC data, and an approved immutable rule version.

The following operational dependencies are not present in this repository and block production activation:

- a production-approved contact-data contract and tenant-bound credential;
- a secure full-scale National/State DNC transfer client and documented registry-account export procedure;
- an immutable evidence-storage uploader and trusted attestor for consent/callback artifacts;
- a tested key-rotation/re-encryption/re-hash migration;
- staging and production migration evidence, backup/restore proof, legal sign-off, and a rollback drill.

No staging or production deployment, live provider activation, live DNC activation, or legal approval is represented by this runbook.

## Environment

Generate independent 32-byte secrets and store them in the deployment secret manager, not source control:

```bash
openssl rand -hex 32 # CALLING_DATA_ENCRYPTION_KEY
openssl rand -hex 32 # PHONE_HASH_KEY
openssl rand -hex 32 # CALL_AUTHORIZATION_SIGNING_KEY
openssl rand -hex 32 # DNC_IMPORT_MANIFEST_SIGNING_KEY
openssl rand -hex 32 # CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY
```

All activation switches must remain false during migration and configuration:

```dotenv
CALLING_MODULE_ENABLED=false
CONTACT_ENRICHMENT_ENABLED=false
NATIONAL_DNC_ENABLED=false
STATE_RULES_ENABLED=false
MANUAL_CLICK_TO_CALL_ENABLED=false
CALLING_EMERGENCY_DISABLED=true
CALLING_PILOT_ORG_IDS=
CALLING_DATA_ENCRYPTION_KEY=
PHONE_HASH_KEY=
CALL_AUTHORIZATION_SIGNING_KEY=
DNC_IMPORT_MANIFEST_SIGNING_KEY=
DNC_ALLOW_DIRECT_IMPORT=false
CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY=
CONTACT_PROVIDER_HOST_ALLOWLIST=
CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST=
CONTACT_PROVIDER_SECRET_BINDINGS_JSON={}
CONTACT_PROVIDER_TIMEOUT_MS=10000
CALL_AUTHORIZATION_TTL_SECONDS=120
```

Do not reuse JWT, session, provider, or database secrets for these keys. Empty provider allowlists and `{}` bindings deliberately authorize no network provider.

The encryption format currently has one `v1` key and no key identifier, and there is no online re-encryption or phone-hash reindex job. Rotating `CALLING_DATA_ENCRYPTION_KEY` in place makes existing encrypted phones/provider evidence unreadable. Rotating `PHONE_HASH_KEY` in place makes existing exact-match and suppression hashes unsearchable. Rotating `CALL_AUTHORIZATION_SIGNING_KEY` invalidates outstanding tokens; invalidate them in the database first. Changing either manifest-signing key invalidates pending, not-yet-verified DNC imports or artifact attestations. Production activation therefore requires a separately reviewed dual-read/re-key migration and restore test; merely replacing an environment value is not a safe rotation procedure.

## Activation gate

Every item is mandatory. A missing item is a blocking result, not a warning.

1. Apply and verify the Calling migration in staging. Back up the database first.
2. Configure all five independent Calling/import/attestation secrets and confirm they decode to exactly 32 bytes.
3. Add a disabled provider configuration with its signed contract/order, permitted-use evidence hash, retention/deletion terms, prices, rate limit, and hard daily/monthly budgets. Configure the exact host, secret-name allowlist, and tenant/provider binding described below.
4. Have counsel approve the seller/offer, federal and state analysis, registrations or documented exemptions, caller ID, calling hours, frequency policy, script, and consent/revocation language.
5. Add seller authorization, state registration/exemption records, one active approved script, and one active immutable rule version.
6. Import authorized, current National DNC and applicable state DNC datasets through the signed pipeline. Verify source age, manifest/chunk checksums, unique record count, authorized account reference, expiry, and a sample known suppression.
7. Integrate and independently security-review an immutable artifact uploader/attestor. Prove that an administrator cannot self-attest a missing recording/form and that retrieval, legal hold, and five-year retention work.
8. Run the complete negative test suite and one seeded staging lifecycle. Confirm generic lead and Field Map APIs never reveal full numbers.
9. Add only trained users to the `calling_rep`, `calling_manager`, `compliance_admin`, or `auditor` roles. Generic reps receive no Calling capabilities.
10. Set `CALLING_PILOT_ORG_IDS` to one staging/pilot organization. Keep the organization profile's `calling_enabled=false` and `emergency_disabled=true` until final sign-off.
11. Enable the global gates one at a time, then enable the provider and organization profile. Switch the emergency stop off last. Re-run a blocked and eligible decision after each change.

## Authoritative decision flow

1. A cross-verified fresh-fiber lead enters the masked Calling queue.
2. A licensed, contract-approved provider may enrich it only within budget and permitted-use scope. Owner and current resident are separate evidence fields; ownership never proves that the owner lives there.
3. The raw number is normalized, encrypted with AES-256-GCM, and indexed only by a tenant-keyed HMAC. APIs return the masked form.
4. Validation records line type, reachability, reassignment risk, evidence reference, checked time, and expiry.
5. The pure compliance engine receives a complete evidence snapshot. It does no I/O and returns the verdict, every rule result, reason codes, local time, rule version, and expiry.
6. An eligible verdict can produce a two-minute, action-bound authorization token. A manual start request atomically rechecks suppression, consent/revocation, queue ownership, local time, rule/script/profile state, and token use before revealing the one number.
7. A disposition is idempotent. `DO_NOT_CALL`, `WRONG_NUMBER`, `WRONG_PARTY`, and `CONSENT_REVOKED` immediately suppress the number, cancel callbacks, close queue work, and invalidate unused authorizations. `NOT_INTERESTED` only closes the current queue item; it is not a permanent opt-out. If the consumer says “stop,” “do not call,” or equivalent, the rep must record `DO_NOT_CALL`, never `NOT_INTERESTED`.
8. Callbacks require a future instant plus the resident timezone. A callback never bypasses current DNC, revocation, hours, or authorization checks.

The decision record stores input and rule hashes rather than raw secret evidence. Audit events are append-only and hash-chained. They must use request/correlation IDs so enrichment, decision, authorization, attempt, disposition, consent, revocation, opt-out, and conversion can be reconstructed.

## DNC operations

The FTC states that covered sellers/telemarketers must use a version of the National Registry downloaded no more than 31 days before calls. Use the organization's own authorized registry account and subscription; do not use a scraped, shared, or fabricated list. See the [FTC DNC Q&A](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0) and [consumer DNC FAQ](https://consumer.ftc.gov/articles/national-do-not-call-registry-faqs).

Freshness is measured from the signed `sourceAsOf` instant—not upload time, import time, or `sourceRetrievedAt`. `maxAgeDays` is constrained to 1–31 days, and expiry is `sourceAsOf + maxAgeDays`. The server validates the signed source dates when an import begins and again when it finalizes. It rejects future-dated sources, retrieval before the source as-of time, sources already outside the signed age window, incomplete coverage, missing chunks, count/checksum mismatches, and invalid signatures.

### Signed, resumable workflow

1. Download the dataset through the organization's authorized registry process. Preserve the account/export receipt and access authorization outside this application. The input file must contain one number per line.
2. Create a local config JSON containing `tenantId`, `sourceType` (`national` or `state`), state when applicable, `versionLabel`, `authorizedAccountRef`, `coveredAreaCodes: ["ALL"]`, `sourceAsOf`, `sourceRetrievedAt`, `maxAgeDays` (maximum 31), and `chunkSize` (maximum 3,000). `ALL` is required because partial area-code coverage remains fail-closed.
3. Inject `DNC_IMPORT_MANIFEST_SIGNING_KEY` from the secret manager into the isolated signing process; do not put it in shell history or the browser. Sign the exact export:

   ```bash
   npm run calling:dnc:sign -- dnc-config.json authorized-export.txt signed-manifest.json
   ```

   The tool normalizes US numbers, calculates the unique expected count, fixes chunk boundaries/counts, hashes each chunk into a source-manifest checksum, and HMAC-signs the tenant/account/coverage/source-age/count/checksum manifest.
4. In Calling Compliance, select `signed-manifest.json` and the exact unchanged `authorized-export.txt`. The client creates the import, uploads sequential chunks, and finalizes. The API accepts an identical replay of a staged chunk, rejects a changed replay, and activates only after all signed chunks and the unique count/checksum match.
5. Verify the final dataset ID, count, checksum, source-as-of time, expiry, and a known suppression before considering the dataset ready. The previous active version is superseded only by the successful finalization transaction.
6. If any required National or state dataset is absent, stale, partial, failed, or revoked, keep calling blocked. Never fall back to an older dataset.
7. Apply organization opt-outs immediately. `internal_dnc_entries` and their event history are retained; corrections preserve the original event.

The legacy direct JSON import endpoint is disabled in production regardless of `DNC_ALLOW_DIRECT_IMPORT`; the flag exists only for isolated non-production tests and defaults false. The browser uploader is limited to 100 MB. Re-selecting the exact signed manifest and unchanged export discovers the existing pending job by its tenant-bound manifest signature and safely replays already accepted chunks; a finalized replay returns the original dataset result. This repository still does not ship a reviewed streaming large-file registry transfer client or asynchronous high-volume finalizer. Do not claim full-scale production DNC operations until that operational client and procedure exist.

The FTC's [TSR compliance guide](https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule) is the federal baseline. The FTC's 2024 [recordkeeping guidance](https://www.ftc.gov/business-guidance/blog/2024/10/mark-your-calendars-telemarketers-sellers-october-15-telemarketing-sales-rules-record-store-day) describes five-year retention for relevant records, including call detail, service providers, DNC versions, and opt-outs. State rules may be stricter. For North Carolina, counsel should review [Chapter 75, Article 4](https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_75/Article_4.html) and the telephonic seller registration/exemption rules in [Chapter 66, Article 33](https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_66/Article_33.html).

## Consent and revocation

Consent is immutable evidence, not a checkbox on a call outcome. A record requires seller, organization, phone, service address, consumer identity (or the explicit value `unavailable`), consent type/channels/scope, disclosure version and text hash, capture time and timezone, method, source, affirmative action, immutable artifact reference, and either a signature reference or voice recording reference. Recorded-call consent always requires the recording reference. IP address and timestamp alone are not durable proof.

Before the application accepts an evidence artifact, a separate trusted storage service must upload it to immutable storage, calculate its SHA-256, commit retention through at least five years after capture, and HMAC-sign the exact canonical manifest fields: tenant, lead, phone, optional call attempt, artifact type, storage provider/reference, artifact SHA-256, captured time, retention-until time, and verification-evidence reference. The API verifies this with `CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY` and stores only a `signed_storage_attestation_v1` result plus evidence references. The browser/admin must never receive the signing key.

This repository contains the verifier and registration endpoint, but no storage uploader, recorder, retrieval service, legal-hold workflow, or trusted attestor that produces these signatures. Setting `CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY` or entering an object reference is not evidence and must not enable Calling. This missing external integration is an explicit production blocker for consent grants and callback evidence.

Revocation is append-only, immediately creates an internal opt-out, and invalidates pending call authorizations. A new consent record must never overwrite or erase revocation history. Whether later consent can lawfully change scope must be approved by counsel and represented as a new record/rule version.

## Provider review and cost model

Prices and terms below are public snapshots reviewed 2026-07-14, not quotes. Vendors may change prices, coverage, or permitted use. A public API key or technically successful response does not grant telemarketing rights. Procurement must attach the signed order and written permitted-use approval to the provider configuration before it can be enabled.

| Service | Public price snapshot | Suitable role | Contract finding |
| --- | ---: | --- | --- |
| Trestle Phone Validation | $0.015/query | phone validation | [Trestle pricing](https://trestleiq.com/pricing/) |
| Trestle Real Contact | $0.03/query | identity/contact append | Trestle's [2024 general terms](https://trestleiq.com/terms-of-service-2024/) restrict marketing use except responding to an inbound request unless an applicable Order changes the use case. Keep disabled without an explicit written Order/amendment. |
| Trestle Reverse Phone/Address | $0.07/query | reverse association | Same contract block as above; caching/retention must follow the signed Order. |
| Twilio Lookup line type | $0.008/request at first public tier | validation only | [Lookup pricing](https://static0.twilio.com/en-us/user-authentication-identity/pricing/lookup); it does not supply resident identity or DNC permission. |
| Twilio Lookup line status | $0.007/request at first public tier | reachability evidence | Same pricing page. |
| Twilio Lookup reassigned number | $0.02/request for the first 1,000, then published volume tiers | reassignment risk | Review the [Lookup v2 API](https://www.twilio.com/docs/lookup/v2-api), including documented PII handling/retention. |
| Melissa Personator Consumer | $12,300/year for 1M public annual credits | contact/address verification | [Melissa pricing](https://www.melissa.com/pricing/); permitted use, retention, and deletion remain contract-specific. |
| Melissa Enrich | $14,300/year for 1M public annual credits | contact enrichment | Review [service/data terms](https://www.melissa.com/hubfs/MelissaDirect_May2024/pdfs/data-services-terms-conditions.pdf) and [data-product terms](https://www.melissa.com/direct/resources/pdf/data-products-terms-conditions.pdf) with counsel. |
| Melissa Property | $1,760/year for 100k public annual credits | ownership/property data | Ownership must remain separate from current-resident identity. |
| Whitepages | No verified public price/telemarketing permission captured | none until procurement | Keep disabled until a signed contract, price, retention rules, and written permitted use are recorded. |

Do not select a vendor by cost per lookup alone. Measure:

```text
total_variable_cost
  = enrichment_queries * enrichment_query_cost
  + validation_queries * validation_query_cost
  + reassignment_queries * reassignment_query_cost
  + DNC subscription/export costs

cost_per_compliant_usable_match
  = total_variable_cost / matches_that_pass_identity_validation_DNC_and_policy

cost_per_completed_manual_call
  = total_variable_cost / completed_human-initiated_attempts
```

Example only: 10,000 $0.03 enrichment queries cost $300 before validation, DNC, failed matches, and contract fees. A lower nominal lookup price can be more expensive if identity confidence or compliant usable-match rate is poor. Enforce per-provider daily/monthly budgets and surface cache hit, match, usable-match, and cost metrics. Cache only when the provider contract permits it, and expire/delete on schedule.

### Provider credential binding

The generic HTTP adapter is unavailable unless every layer agrees:

- the provider row uses a credential-free `https://` base URL and an exact `providerName` plus `secretEnvName`;
- the URL hostname is present in comma-separated `CONTACT_PROVIDER_HOST_ALLOWLIST`;
- the secret environment-variable name is present in `CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST`;
- `CONTACT_PROVIDER_SECRET_BINDINGS_JSON` maps the exact tenant ID and provider name to that exact secret environment-variable name;
- that named environment variable contains the secret.

Binding format (illustrative structure only, not a vendor approval):

```dotenv
CONTACT_PROVIDER_HOST_ALLOWLIST=api.contract-approved-provider.example
CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST=TENANT_42_CONTACT_PROVIDER_KEY
CONTACT_PROVIDER_SECRET_BINDINGS_JSON='{"42":{"contract-approved-provider":"TENANT_42_CONTACT_PROVIDER_KEY"}}'
TENANT_42_CONTACT_PROVIDER_KEY=
```

Provider-name comparison is exact and case-sensitive. A global hostname or secret allowlist by itself never authorizes another tenant to use the credential. The server also rejects URL credentials, non-HTTPS endpoints, restricted/private network destinations, DNS rebinding to restricted addresses, oversized responses, and non-allowlisted secrets. Retries are limited to network failures, HTTP 429, and 5xx responses; a stable upstream operation ID is reused to reduce duplicate charge risk. Do not configure automatic provider fallback until idempotency and billing behavior are contractually verified.

## Data retention and security

- Retain consent, revocation, DNC version, suppression, authorization, attempt, disposition, provider, and audit evidence for at least five years, or longer where the approved policy requires it. The schema default is five years; legal hold overrides deletion.
- Encrypt full phone numbers and raw provider responses at rest with AES-256-GCM. Never log, index, place in analytics, or return them from generic lead APIs.
- Use a tenant-keyed phone HMAC for equality checks. Mask all list/detail responses outside the one atomic manual-start response.
- Keep provider credentials in named environment secrets; never store them in database JSON or client bundles.
- Apply capability and tenant checks on every route. A resource ID alone is never authorization.
- Bind authorization tokens to tenant/user/lead/contact/phone/decision/action, hash the stored token and nonce, expire quickly, and consume once in the same transaction as attempt creation.
- Preserve append-only opt-out, consent, and audit records. Verify the audit hash chain and database foreign keys in scheduled integrity checks.
- Treat exports as sensitive. Require auditor/compliance capability, narrow time windows, redact phones by default, and audit each export.

## Monitoring

Alert on emergency-stop changes, calling/profile/provider enablement, stale DNC datasets, failed DNC imports, authorization start failures, cross-tenant denials, repeated token reuse, calls outside configured hours, unapproved provider attempts, budget/circuit thresholds, audit-chain gaps, and any full phone observed in a non-Calling response or log.

Core health counters should include decision totals by reason (without PII), DNC dataset age, manual authorizations issued/used/expired/invalidated, opt-out propagation latency, callback cancellation latency, provider spend and usable-match rate, and authorization-to-disposition completeness.

## Emergency stop, rollback, and recovery

To stop calls immediately:

1. Set `CALLING_EMERGENCY_DISABLED=true` and `CALLING_MODULE_ENABLED=false` in the runtime secret/config system and restart or reload all instances.
2. Set every organization profile `emergency_disabled=true` and `calling_enabled=false`.
3. Disable every enrichment provider.
4. Invalidate all unused, unexpired authorizations with reason `emergency_stop`; do not delete them.
5. Confirm new decision and manual-start requests fail closed across every instance, then investigate using redacted audit events.

Application rollback may revert route/UI code after the stop is verified. Do not roll back by dropping Calling tables or restoring an older database over newer DNC, opt-out, revocation, consent, call, or audit evidence. Schema rollback is forward-only: deploy a corrective migration that preserves these records. Restore tests must prove that suppression hashes, encryption keys, evidence references, and the audit chain still resolve before re-enabling.

No production deployment or live provider/DNC activation is established by this document. Record the exact migration output, test run, staging URL, release SHA, operator, backup identifier, flag changes, and rollback drill as deployment evidence.

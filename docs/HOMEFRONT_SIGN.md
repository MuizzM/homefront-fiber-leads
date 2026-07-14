# Home Front Sign

Home Front Sign is the portal’s first-party electronic-signature service for rep onboarding. It does not require DocuSign or another paid e-signature vendor. Managers issue versioned agreements, Resend emails the rep, and the authenticated rep reviews and signs inside the portal.

## Evidence retained for each signature

- the complete agreement snapshot and its SHA-256 digest;
- document type, version, company, signer name/email, and issue time;
- affirmative electronic-record consent, acknowledgment of review, and intent to sign;
- authenticated portal user ID, server timestamp, IP address, and user agent;
- signature-evidence SHA-256 and completed-PDF SHA-256;
- a downloadable signed PDF with an electronic-signature certificate;
- a hash-chained event history covering creation, invitation, viewing, signing, and receipt delivery;
- seven-year minimum retention timestamp, with no automatic deletion job.

The agreement text is in `server/onboardingAgreementTemplates.ts`. Have qualified counsel review the terms before using them with real representatives, especially contractor classification, commission deductions, local solicitation law, and state-specific employment rules. The signing system supplies evidence and record integrity; it does not make unsuitable contract terms lawful.

## Resend setup

Verify the sending domain in Resend and create an API key. Configure production with:

```env
APP_ORIGIN=https://portal.homefrontsolutionsllc.com
CAREERS_TENANT_SLUG=home-front-solutions
RESEND_API_KEY=re_your_api_key
RESEND_FROM=Home Front Solutions <noreply@portal.homefrontsolutionsllc.com>
ONBOARDING_INVITE_SECRET=<64-character output from: openssl rand -hex 32>
```

For backward compatibility, Home Front Sign will use `SMTP_PASS` as the Resend API key and `MAIL_FROM` as the sender when `SMTP_HOST=smtp.resend.com`. New deployments should set the explicit `RESEND_*` variables.

Resend must show the sender domain as verified. SPF and DKIM should pass, and DMARC is recommended. Invitations use an idempotency key derived from the issued record IDs, preventing duplicate email delivery during a retry. Completion receipts use the record UUID as their idempotency key and attach the signed PDF.

## Signing workflow

1. An administrator or manager opens **Rep Onboarding**, enters a candidate’s name and email, and selects **Send private invite**. The server creates a tenant-scoped recruiting record first, signs a candidate-specific 14-day link with `ONBOARDING_INVITE_SECRET`, stores only the token digest, and sends it through Resend. Candidates may also start from the public marketing careers page.
2. The candidate applies without an account or organization membership. A private invitation token is authoritative for tenant routing. A marketing-site submission sends `applicationSource=careers`, which the server maps to the server-owned `CAREERS_TENANT_SLUG`; it never accepts a tenant ID from the browser. Both sources enter the same queue.
3. An administrator selects the commission structure and chooses **Approve & Start Onboarding**. Managers may monitor the tenant queue but cannot approve or reject applicants.
4. The server creates and links the rep account and team profile, assigns the commission structure, creates a one-time login code, and freezes all four required agreement snapshots.
5. The rep receives a welcome/login-code email and a Home Front Sign email linking to **My Documents**. No bearer signing token appears in email.
6. The rep signs in, reviews each complete record, accepts the electronic-record disclosure, acknowledges review, confirms intent, and types the exact legal name on the rep profile.
7. The server creates the evidence digest and signed PDF, commits both atomically, and records a hash-chained signing event.
8. Resend emails each completed PDF. The same PDFs remain available to the rep and authorized managers. Only after all four current required agreements are complete does the server activate the field-sales team profile.

Managers use **Rep Onboarding** for every onboarding action, including safe resends and signed-PDF downloads. The Team roster links back to that one operational screen instead of presenting a second document workflow. Active agreements are idempotent: approving or retrying cannot create a second active copy of the same document type or version.

## Tenant and account safety

- `POST /api/onboarding/apply` is public, rate-limited before file upload, validates and bounds every field, and requires consent for careers-source submissions.
- Secure invitation tokens override all source/slug fields. Unknown organization slugs fail closed.
- Careers submissions are routed only through `CAREERS_TENANT_SLUG`, which must be a tenant already stored by the server.
- Review queries and decisions are tenant-scoped. Only an administrator in the owning tenant can approve or reject.
- A `NULL` tenant on an existing rep login/profile means pre-membership and may be claimed during approval. A non-null different tenant remains a hard conflict.
- Approval retries reuse the linked user and team member, do not resend an already accepted welcome email, and do not create duplicate active agreements.
- The team profile stays inactive until every required current agreement is signed. The login remains usable so the candidate can complete signing.

For local browser tests only, `RESEND_DELIVERY_MODE=log` records delivery metadata without contacting Resend. This switch is ignored when `NODE_ENV=production`.

## Production verification

1. Send one agreement to a test rep with a real email address.
2. Confirm the invitation appears in the Resend dashboard and arrives from the verified domain.
3. Confirm the signature button remains disabled until the document is reviewed and all three acknowledgments are checked.
4. Sign using the exact rep-profile name.
5. Download the PDF from both the rep account and an authorized manager account.
6. Confirm the SHA-256 values on the PDF certificate match the stored `content_sha256`, `signature_sha256`, and `completed_pdf_sha256` values.
7. Confirm the Resend completion receipt contains the same PDF.
8. Confirm another rep and another tenant cannot read or download the record.

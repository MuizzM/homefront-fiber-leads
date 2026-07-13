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
RESEND_API_KEY=re_your_api_key
RESEND_FROM=Home Front Solutions <noreply@portal.homefrontsolutionsllc.com>
```

For backward compatibility, Home Front Sign will use `SMTP_PASS` as the Resend API key and `MAIL_FROM` as the sender when `SMTP_HOST=smtp.resend.com`. New deployments should set the explicit `RESEND_*` variables.

Resend must show the sender domain as verified. SPF and DKIM should pass, and DMARC is recommended. Invitations use an idempotency key derived from the issued record IDs, preventing duplicate email delivery during a retry. Completion receipts use the record UUID as their idempotency key and attach the signed PDF.

## Signing workflow

1. A manager opens **Team → Onboarding** for a rep and sends the required agreements.
2. The server freezes the exact agreement content and records its SHA-256 digest.
3. Resend emails one authenticated portal link. No bearer signing token appears in email.
4. The rep signs in, opens **My Documents**, and reviews the complete record.
5. The rep reaches the end, accepts the electronic-record disclosure, acknowledges review, confirms intent, and types the exact legal name on the rep profile.
6. The server creates the evidence digest and signed PDF, commits both atomically, and records a hash-chained signing event.
7. Resend emails the completed PDF. The same PDF remains available to the rep and authorized managers.

## Production verification

1. Send one agreement to a test rep with a real email address.
2. Confirm the invitation appears in the Resend dashboard and arrives from the verified domain.
3. Confirm the signature button remains disabled until the document is reviewed and all three acknowledgments are checked.
4. Sign using the exact rep-profile name.
5. Download the PDF from both the rep account and an authorized manager account.
6. Confirm the SHA-256 values on the PDF certificate match the stored `content_sha256`, `signature_sha256`, and `completed_pdf_sha256` values.
7. Confirm the Resend completion receipt contains the same PDF.
8. Confirm another rep and another tenant cannot read or download the record.

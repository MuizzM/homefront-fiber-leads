# Sign-in delivery incident

## Outcome

Identify why the user is not receiving sign-in codes and restore the existing
email login path without weakening authentication or exposing secrets.

## Context

Reported immediately after cleanup release 5df4ccf. Mail transports, OTP handlers,
Login, storage and mail env readers are unchanged by that release. Production
returns success before delivery completes; unknown/inactive accounts also receive
the same response. Existing perf reports exclude plaintext mail errors.

## Safety invariants

- Read-only diagnosis: no account changes, new codes, rate-limit resets, restarts
  or provider sends from the diagnostic workflow.
- Preserve the production environment gate and pinned SSH host key.
- Never read OTP values/session tokens or print raw logs, credentials, IPs or
  email addresses. Emit only account status, bounded audit metadata and error
  categories. Secrets stay on the configured host/runner.
- Follow the existing exact-SHA CI gate for any eventual app deployment.

## Milestones

1. Trace unchanged auth/delivery paths and compare release scope.
2. Add bounded read-only diagnostic with privacy regression tests.
3. Review, validate and run the diagnostic through the production environment.
4. Address the evidenced cause and verify delivery to the user.

## Progress

- [x] 2026-09-05: Auth trace and release comparison complete; no direct cleanup
  change to mail or sign-in behavior found.
- [x] Read-only diagnostic reviewed, validated and run (Actions 33975568691).
- [x] Diagnostic privacy review complete; three regression tests, both type
  checkers, harness/deployment checks and workflow/shell parsing passed.
- [x] Full repository verification passed 619 files / 7,747 tests and build.
- [ ] Cause resolved and user delivery confirmed.

## Decisions

Use a manual operational workflow because the production SSH key exists only
in GitHub and the existing reporting workflow drops mail failures. Preserve its
production protection boundary. Keep the app release unchanged during diagnosis.

## Discoveries

The response field emailDelivered is optimistic in production. Request history
and delivery errors are needed to distinguish rate limits, account state and
provider rejection. Repeat requests invalidate earlier codes and can lock the
account, so avoid speculative resends.

Review addressed step-environment email exposure, arbitrary audit text, internal
execution deadlines, input byte limits and the distinction between stored bucket
counts and active lockouts. Metadata queries are parameterized and read-only.

Production diagnosis: account exists, active, no request lockout. Four recent
requests recorded code_created_mail_failed; global current-container logs show
sender_domain rejection. MAIL_FROM uses portal.homefrontsolutionsllc.com; Resend
HTTP uses the existing SMTP_PASS fallback. Public Porkbun DNS has no Resend DKIM
or send-subdomain SPF/MX records. Read the provider's exact expected public DNS
records before proposing a repair; preserve apex Microsoft 365 mail records.

## Validation

Test redaction and account isolation with fake data. Validate workflow YAML,
embedded shell syntax, harness/deployment guards and repository checks. Require
the read-only workflow to complete and classify the observed cause.

## Recovery

The diagnostic changes no runtime state or database content. Remove its workflow
and script if no longer needed. Any app fix retains the existing code rollback.

## Result

Diagnosis in progress.

## Outcome

Describe the observable behavior and why it matters.

## Safety boundaries

- [ ] Tenant isolation and server-side authorization reviewed
- [ ] Sensitive data and logs reviewed
- [ ] Scanner/provider spend and stop conditions reviewed, if applicable
- [ ] Migration and recovery path reviewed, if applicable
- [ ] No production action, secret change, or destructive operation is hidden in this PR

## Validation

List exact commands and results. Explain any skipped check.

- [ ] `npm run harness:check`
- [ ] `bash tests/deployment-safety.sh`
- [ ] `npm run check`
- [ ] Relevant tests
- [ ] `npm run build` for cross-cutting changes

## Risk and recovery

Describe likely failure modes, monitoring, rollback, or why no special recovery is needed.

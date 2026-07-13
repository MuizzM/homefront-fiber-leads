# DocuSign rep onboarding

Home Front’s onboarding module sends four required agreements from manager-owned DocuSign templates, opens an embedded signing session for the assigned rep, consumes signed Connect events, and exposes the completed PDF plus certificate to the rep and authorized managers.

## 1. Create the DocuSign integration

Use a DocuSign developer account until the complete workflow has been verified.

1. In **Apps and Keys**, create an integration key and an RSA key pair.
2. Record the integration key, API user GUID, API account ID, and private key.
3. Grant the API user one-time JWT consent by visiting this URL while signed in as that user (replace both values):

   ```text
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=INTEGRATION_KEY&redirect_uri=REGISTERED_REDIRECT_URI
   ```

4. Base64-encode the entire private PEM file for `DOCUSIGN_PRIVATE_KEY_BASE64`:

   ```bash
   base64 < private.key | tr -d '\n'
   ```

The server exchanges a signed JWT for a short-lived access token and discovers the account-specific REST base URI. Tokens are cached in memory and the private key never reaches the browser.

## 2. Create the agreement templates

Create these four templates in DocuSign:

- Independent Contractor Agreement
- Commission Agreement
- Confidentiality & Data Protection Agreement
- Field Safety & Conduct Acknowledgment

Each template must have exactly one signer role named `Rep`, unless `DOCUSIGN_TEMPLATE_ROLE_NAME` is changed to match. Add all required signature, initial, date, and text tabs in DocuSign, then copy each template GUID into its corresponding environment variable.

Home Front intentionally does not generate legal language. Have employment counsel approve the template contents and worker-classification terms for every state where reps work.

## 3. Configure Connect HMAC

Create a DocuSign Connect configuration that sends JSON notifications and enable HMAC signing. Set the listener URL to:

```text
https://portal.homefrontsolutionsllc.com/api/onboarding/documents/webhook/docusign
```

Store the same HMAC key in `DOCUSIGN_CONNECT_HMAC_SECRET`. The endpoint reads the original request bytes, verifies `X-DocuSign-Signature-1` with constant-time SHA-256 HMAC comparison, ignores duplicate payloads, and prevents stale events from downgrading a completed envelope.

Subscribe to envelope `Sent`, `Delivered`, `Completed`, `Declined`, and `Voided` events. The application also attaches this event notification configuration to every envelope it creates.

## 4. Environment

```dotenv
DOCUSIGN_AUTH_SERVER=account-d.docusign.com
DOCUSIGN_INTEGRATION_KEY=...
DOCUSIGN_USER_ID=...
DOCUSIGN_ACCOUNT_ID=...
DOCUSIGN_PRIVATE_KEY_BASE64=...
DOCUSIGN_CONNECT_HMAC_SECRET=...
DOCUSIGN_CONNECT_WEBHOOK_URL=https://portal.homefrontsolutionsllc.com/api/onboarding/documents/webhook/docusign
DOCUSIGN_TEMPLATE_ROLE_NAME=Rep
DOCUSIGN_TEMPLATE_INDEPENDENT_CONTRACTOR=...
DOCUSIGN_TEMPLATE_COMMISSION_AGREEMENT=...
DOCUSIGN_TEMPLATE_CONFIDENTIALITY=...
DOCUSIGN_TEMPLATE_FIELD_SAFETY=...
```

Restart the application after updating the production `.env`. The manager dialog stays disabled until all credentials and all four template IDs are present.

## 5. End-to-end verification

1. Open **Team** as an admin or manager.
2. Ensure the rep has a unique email and linked login.
3. Select the signature icon in that rep’s action row and send the required documents.
4. Sign in as the rep, open **My Documents**, and select **Review & sign**.
5. Complete the DocuSign ceremony and return to Home Front.
6. Confirm the envelope becomes **Signed** after the Connect notification.
7. Download the combined PDF and completion certificate from either screen.
8. Confirm the activity log includes send, signing-opened, and status-changed events.

Before moving from the developer environment to production, complete DocuSign’s go-live process, switch `DOCUSIGN_AUTH_SERVER` to `account.docusign.com`, use the production account/template IDs, and create a production Connect configuration and HMAC key.

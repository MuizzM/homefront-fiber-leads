import type Database from "better-sqlite3";
import { apexEmails } from "../platformApex";

/** Additive core; called after users, tenants, sessions and OTP/outbox schema.
 * A managed anchor intentionally RESTRICTs account deletion. Removing that
 * anchor would let a deprovisioned identity return through ordinary email login. */
export function ensureIdentityCoreSchema(db: Database.Database): void {
  db.transaction(() => {
    db.prepare("SELECT id,tenant_id,email,active,role,team_member_id,is_super_admin FROM users LIMIT 0").all();
    db.prepare("SELECT id,status FROM tenants LIMIT 0").all();
    db.prepare("SELECT id,user_id,created_at,expires_at FROM sessions LIMIT 0").all();
    db.prepare("SELECT id,email,used FROM otp_codes LIMIT 0").all();
    db.prepare("SELECT user_id,status,payload,lease_token,lease_until,completed_at FROM auth_delivery_outbox LIMIT 0").all();
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_reserved_emails(email TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_users_identity_email ON users(lower(trim(email)));
      CREATE INDEX IF NOT EXISTS idx_identity_session_capacity ON sessions(user_id,julianday(expires_at));
      CREATE TABLE IF NOT EXISTS identity_user_security(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK(auth_epoch>=0)
      );
      CREATE TABLE IF NOT EXISTS identity_mfa_state(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
      );
      CREATE TABLE IF NOT EXISTS identity_accounts(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT CHECK(tenant_id>0),
        approval_state TEXT NOT NULL DEFAULT 'pending' CHECK(approval_state IN ('pending','approved','rejected')),
        lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_generation>0),
        approved_generation INTEGER,
        directory_active INTEGER NOT NULL DEFAULT 1 CHECK(directory_active IN (0,1)),
        directory_deleted INTEGER NOT NULL DEFAULT 0 CHECK(directory_deleted IN (0,1)),
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(user_id,tenant_id),
        CHECK((approval_state='approved' AND approved_generation IS NOT NULL AND approved_generation=lifecycle_generation)
          OR (approval_state!='approved' AND approved_generation IS NULL)),
        CHECK(directory_deleted=0 OR directory_active=0),
        CHECK(approval_state!='approved' OR (directory_active=1 AND directory_deleted=0))
      );
      CREATE INDEX IF NOT EXISTS idx_identity_accounts_review ON identity_accounts(tenant_id,approval_state,user_id);
      CREATE TABLE IF NOT EXISTS identity_policies(
        tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT CHECK(tenant_id>0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
        require_mfa INTEGER NOT NULL DEFAULT 0 CHECK(require_mfa IN (0,1)),
        require_sso INTEGER NOT NULL DEFAULT 0 CHECK(require_sso IN (0,1)),
        session_limit INTEGER CHECK(session_limit BETWEEN 1 AND 50),
        idle_timeout_ms INTEGER CHECK(idle_timeout_ms BETWEEN 300000 AND 2592000000),
        absolute_timeout_ms INTEGER CHECK(absolute_timeout_ms BETWEEN 3600000 AND 31536000000),
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL,
        CHECK(idle_timeout_ms IS NULL OR absolute_timeout_ms IS NULL OR idle_timeout_ms<=absolute_timeout_ms)
      );
      CREATE TABLE IF NOT EXISTS identity_devices(
        id TEXT PRIMARY KEY CHECK(length(id)<=80),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id INTEGER,
        binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
        label TEXT NOT NULL CHECK(length(label)<=120),
        trusted INTEGER NOT NULL DEFAULT 0 CHECK(trusted IN (0,1)),
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        UNIQUE(user_id,binding_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_devices_user ON identity_devices(user_id,last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS identity_session_assurance(
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id INTEGER,
        auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
        primary_method TEXT NOT NULL CHECK(primary_method IN ('email','saml','oidc')),
        connection_id TEXT, connection_revision INTEGER,
        mfa_method TEXT CHECK(mfa_method IN ('totp','webauthn','recovery','sms')),
        mfa_verified_at INTEGER,
        factor_revision INTEGER,
        device_id TEXT REFERENCES identity_devices(id) ON DELETE SET NULL,
        authenticated_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        CHECK((mfa_method IS NULL AND mfa_verified_at IS NULL) OR (mfa_method IS NOT NULL AND mfa_verified_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_identity_sessions_user ON identity_session_assurance(user_id,session_id);
      CREATE TABLE IF NOT EXISTS identity_completion_receipts(
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
        browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tenant_id INTEGER,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        completed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        CHECK(expires_at>completed_at AND expires_at-completed_at<=120000)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_completion_expiry ON identity_completion_receipts(expires_at);
      CREATE TABLE IF NOT EXISTS identity_continuations(
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
        browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id INTEGER,
        auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
        primary_method TEXT NOT NULL CHECK(primary_method IN ('email','saml','oidc')),
        connection_id TEXT, connection_revision INTEGER,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
        mfa_method TEXT CHECK(mfa_method IN ('totp','webauthn','recovery','sms')),
        mfa_verified_at INTEGER, factor_revision INTEGER,
        device_hash TEXT NOT NULL CHECK(length(device_hash)=64),
        device_label TEXT NOT NULL CHECK(length(device_label)<=120),
        CHECK(expires_at>created_at AND expires_at-created_at<=600000),
        CHECK((mfa_method IS NULL AND mfa_verified_at IS NULL) OR (mfa_method IS NOT NULL AND mfa_verified_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_identity_continuations_user ON identity_continuations(user_id,expires_at);
      CREATE INDEX IF NOT EXISTS idx_identity_continuations_expiry ON identity_continuations(expires_at);
      CREATE TABLE IF NOT EXISTS identity_totp_factors(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret TEXT NOT NULL, secret_revision INTEGER NOT NULL CHECK(secret_revision>0),
        last_time_step INTEGER NOT NULL CHECK(last_time_step>=0), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_totp_enrollments(
        continuation_hash TEXT PRIMARY KEY REFERENCES identity_continuations(token_hash) ON DELETE CASCADE,
        secret TEXT NOT NULL, secret_revision INTEGER NOT NULL CHECK(secret_revision>0)
      );
      CREATE TABLE IF NOT EXISTS identity_recovery_codes(
        token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_identity_recovery_user ON identity_recovery_codes(user_id);
      CREATE TABLE IF NOT EXISTS identity_mfa_attempts(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        window_start INTEGER NOT NULL, failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 10)
      );
      CREATE TABLE IF NOT EXISTS identity_webauthn_users(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        handle TEXT NOT NULL UNIQUE CHECK(length(handle)=43)
      );
      CREATE TABLE IF NOT EXISTS identity_mfa_crypto_budget(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        window_start INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 10)
      );
      CREATE TABLE IF NOT EXISTS identity_passkeys(
        credential_id TEXT PRIMARY KEY CHECK(length(credential_id) BETWEEN 1 AND 2048),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL, counter INTEGER NOT NULL CHECK(counter>=0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
        rp_id TEXT NOT NULL, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
        transports TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(transports)),
        device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
        backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)), created_at INTEGER NOT NULL,last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_identity_passkeys_user ON identity_passkeys(user_id,credential_id);
      CREATE TABLE IF NOT EXISTS identity_webauthn_challenges(
        continuation_hash TEXT PRIMARY KEY REFERENCES identity_continuations(token_hash) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('registration','authentication')),
        challenge TEXT NOT NULL CHECK(length(challenge) BETWEEN 32 AND 256),
        rp_id TEXT NOT NULL, origin TEXT NOT NULL, factor_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_otp_bindings(
        otp_id INTEGER PRIMARY KEY REFERENCES otp_codes(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id INTEGER, auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_otp_owner ON identity_otp_bindings(user_id,otp_id);
      CREATE TABLE IF NOT EXISTS identity_audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER, actor_id INTEGER, subject_user_id INTEGER,
        action TEXT NOT NULL CHECK(length(action)<=80),
        detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_identity_audit_tenant ON identity_audit_events(tenant_id,id DESC);
      CREATE TRIGGER IF NOT EXISTS identity_anchor_insert BEFORE INSERT ON identity_accounts BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND tenant_id=NEW.tenant_id AND is_super_admin=0
          AND lower(trim(email)) NOT IN (SELECT email FROM identity_reserved_emails))
          THEN RAISE(ABORT,'managed_identity_owner_mismatch') END;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_anchor_no_retarget BEFORE UPDATE OF user_id,tenant_id ON identity_accounts
        WHEN NEW.user_id IS NOT OLD.user_id OR NEW.tenant_id IS NOT OLD.tenant_id BEGIN
        SELECT RAISE(ABORT,'managed_identity_cannot_retarget');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_anchor_no_delete BEFORE DELETE ON identity_accounts BEGIN
        SELECT RAISE(ABORT,'managed_identity_requires_deprovision');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_directory_transition BEFORE UPDATE ON identity_accounts
        WHEN NEW.directory_active IS NOT OLD.directory_active OR NEW.directory_deleted IS NOT OLD.directory_deleted BEGIN
        SELECT CASE WHEN NEW.lifecycle_generation!=OLD.lifecycle_generation+1 OR NEW.approval_state!='pending'
          OR NEW.approved_generation IS NOT NULL OR NEW.approved_by IS NOT NULL
          THEN RAISE(ABORT,'directory_transition_requires_fresh_approval') END;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_generation_monotonic BEFORE UPDATE ON identity_accounts
        WHEN NEW.lifecycle_generation<OLD.lifecycle_generation BEGIN
        SELECT RAISE(ABORT,'identity_generation_cannot_decrease');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_managed_user_boundary BEFORE UPDATE OF tenant_id,is_super_admin,email ON users
        WHEN EXISTS(SELECT 1 FROM identity_accounts WHERE user_id=OLD.id)
          AND (NEW.tenant_id IS NOT OLD.tenant_id OR NEW.is_super_admin!=0
            OR lower(trim(NEW.email)) IN (SELECT email FROM identity_reserved_emails)) BEGIN
        SELECT RAISE(ABORT,'managed_identity_cannot_retarget');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_mfa_user_boundary BEFORE UPDATE OF tenant_id ON users
        WHEN NEW.tenant_id IS NOT OLD.tenant_id AND EXISTS(SELECT 1 FROM identity_mfa_state WHERE user_id=OLD.id AND enabled=1) BEGIN
        SELECT RAISE(ABORT,'identity_mfa_cannot_retarget');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_security_initialize AFTER INSERT ON identity_accounts BEGIN
        INSERT OR IGNORE INTO identity_user_security(user_id,auth_epoch) VALUES(NEW.user_id,0);
        UPDATE identity_user_security SET auth_epoch=auth_epoch+1 WHERE user_id=NEW.user_id;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_security_no_reset BEFORE UPDATE ON identity_user_security
        WHEN NEW.user_id IS NOT OLD.user_id OR NEW.auth_epoch<OLD.auth_epoch BEGIN
        SELECT RAISE(ABORT,'identity_security_cannot_reset');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_security_no_delete BEFORE DELETE ON identity_user_security
        WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN
        SELECT RAISE(ABORT,'identity_security_cannot_reset');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_mfa_initial_state BEFORE INSERT ON identity_mfa_state
        WHEN NEW.enabled!=0 OR NEW.revision!=0 BEGIN
        SELECT RAISE(ABORT,'identity_mfa_requires_enrollment');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_mfa_no_reset BEFORE UPDATE ON identity_mfa_state
        WHEN NEW.user_id IS NOT OLD.user_id OR NEW.revision<OLD.revision OR (NEW.enabled!=OLD.enabled AND NEW.revision<=OLD.revision) BEGIN
        SELECT RAISE(ABORT,'identity_mfa_requires_revision');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_mfa_no_delete BEFORE DELETE ON identity_mfa_state
        WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN
        SELECT RAISE(ABORT,'identity_mfa_requires_revision');
      END;
      CREATE TRIGGER IF NOT EXISTS identity_lifecycle_changed AFTER UPDATE OF approval_state,lifecycle_generation,directory_active,directory_deleted ON identity_accounts
        WHEN NEW.approval_state IS NOT OLD.approval_state OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
          OR NEW.directory_active IS NOT OLD.directory_active OR NEW.directory_deleted IS NOT OLD.directory_deleted BEGIN
        UPDATE identity_user_security SET auth_epoch=auth_epoch+1 WHERE user_id=NEW.user_id;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_local_security_changed AFTER UPDATE OF email,active,role,team_member_id,tenant_id,is_super_admin ON users
        WHEN NEW.email IS NOT OLD.email OR NEW.active IS NOT OLD.active OR NEW.role IS NOT OLD.role OR NEW.team_member_id IS NOT OLD.team_member_id
          OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.is_super_admin IS NOT OLD.is_super_admin BEGIN
        INSERT OR IGNORE INTO identity_user_security(user_id,auth_epoch) VALUES(NEW.id,0);
        UPDATE identity_user_security SET auth_epoch=auth_epoch+1 WHERE user_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_mfa_changed AFTER UPDATE OF enabled,revision ON identity_mfa_state
        WHEN NEW.enabled IS NOT OLD.enabled OR NEW.revision IS NOT OLD.revision BEGIN
        INSERT OR IGNORE INTO identity_user_security(user_id,auth_epoch) VALUES(NEW.user_id,0);
        UPDATE identity_user_security SET auth_epoch=auth_epoch+1 WHERE user_id=NEW.user_id;
      END;
      CREATE TRIGGER IF NOT EXISTS identity_epoch_revokes AFTER UPDATE OF auth_epoch ON identity_user_security
        WHEN NEW.auth_epoch!=OLD.auth_epoch BEGIN
        DELETE FROM sessions WHERE user_id=NEW.user_id;
        DELETE FROM identity_continuations WHERE user_id=NEW.user_id;
        UPDATE otp_codes SET used=1 WHERE id IN(SELECT otp_id FROM identity_otp_bindings WHERE user_id=NEW.user_id);
        UPDATE auth_delivery_outbox SET status='discarded',payload=NULL,lease_token=NULL,lease_until=NULL,
          completed_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
          WHERE user_id=NEW.user_id AND status IN ('pending','processing');
      END;
    `);
    const reserve = db.prepare("INSERT OR IGNORE INTO identity_reserved_emails(email) VALUES(?)");
    for (const email of apexEmails()) reserve.run(email);
  }).immediate();
}

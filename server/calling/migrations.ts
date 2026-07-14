import { rawDb } from "../db";

const CALLING_SCHEMA_VERSION = "2026-07-14-calling-v4";

/**
 * Calling migrations are isolated and transactional. Unlike the historical
 * best-effort migration list, a compliance schema failure aborts startup so a
 * half-created DNC/authorization system can never report healthy.
 */
export function runCallingMigrations(): void {
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS calling_schema_versions (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS organization_compliance_profiles (
        tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        calling_enabled INTEGER NOT NULL DEFAULT 0 CHECK(calling_enabled IN (0,1)),
        emergency_disabled INTEGER NOT NULL DEFAULT 1 CHECK(emergency_disabled IN (0,1)),
        counsel_approved INTEGER NOT NULL DEFAULT 0 CHECK(counsel_approved IN (0,1)),
        seller_authorized INTEGER NOT NULL DEFAULT 0 CHECK(seller_authorized IN (0,1)),
        seller_name TEXT,
        seller_authorization_ref TEXT,
        state_rules_approved INTEGER NOT NULL DEFAULT 0 CHECK(state_rules_approved IN (0,1)),
        default_time_zone TEXT NOT NULL DEFAULT 'America/New_York',
        allowed_start_local TEXT NOT NULL DEFAULT '08:00',
        allowed_end_local TEXT NOT NULL DEFAULT '21:00',
        minimum_identity_confidence REAL NOT NULL DEFAULT 0.85,
        max_attempts_7_days INTEGER NOT NULL DEFAULT 2,
        max_attempts_30_days INTEGER NOT NULL DEFAULT 3,
        dnc_max_age_days INTEGER NOT NULL DEFAULT 31,
        allow_national_dnc_consent_override INTEGER NOT NULL DEFAULT 0,
        allow_state_dnc_consent_override INTEGER NOT NULL DEFAULT 0,
        propagate_opt_out_platform_wide INTEGER NOT NULL DEFAULT 0 CHECK(propagate_opt_out_platform_wide IN (0,1)),
        caller_id_authorized INTEGER NOT NULL DEFAULT 0,
        caller_id_reference TEXT,
        retention_years INTEGER NOT NULL DEFAULT 5,
        policy_version INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_calling_users_tenant_id ON users(tenant_id,id);

      CREATE TABLE IF NOT EXISTS calling_representative_holds (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        representative_user_id INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
        placed_by INTEGER NOT NULL,
        placed_at TEXT NOT NULL,
        released_by INTEGER,
        release_reason TEXT,
        released_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,id),
        FOREIGN KEY (tenant_id,representative_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id,placed_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id,released_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
        CHECK(
          (released_by IS NULL AND release_reason IS NULL AND released_at IS NULL)
          OR
          (released_by IS NOT NULL AND release_reason IS NOT NULL
            AND length(trim(release_reason)) BETWEEN 3 AND 1000 AND released_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_calling_representative_active_hold
        ON calling_representative_holds(tenant_id,representative_user_id) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_calling_representative_hold_history
        ON calling_representative_holds(tenant_id,representative_user_id,placed_at DESC);

      CREATE TABLE IF NOT EXISTS seller_authorizations (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        seller_name TEXT NOT NULL,
        authorization_ref TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','active','expired','revoked')),
        evidence_sha256 TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, authorization_ref)
      );

      CREATE TABLE IF NOT EXISTS state_registrations (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        legal_entity TEXT NOT NULL,
        registration_type TEXT NOT NULL CHECK(registration_type IN ('registration','documented_exemption')),
        registration_number TEXT,
        exemption_type TEXT,
        evidence_ref TEXT NOT NULL,
        counsel_approved INTEGER NOT NULL DEFAULT 0,
        effective_at TEXT NOT NULL,
        expires_at TEXT,
        last_reviewed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','active','expired','revoked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, state, registration_type, evidence_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_state_registrations_active
        ON state_registrations(tenant_id,state,status,expires_at);

      CREATE TABLE IF NOT EXISTS approved_calling_scripts (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        disclosure_sha256 TEXT NOT NULL,
        seller_name TEXT NOT NULL,
        company_name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        counsel_approved INTEGER NOT NULL DEFAULT 0,
        counsel_approval_reference TEXT,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_script_active
        ON approved_calling_scripts(tenant_id) WHERE active=1;

      CREATE TABLE IF NOT EXISTS contact_enrichment_providers (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider_name TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 100,
        contract_status TEXT NOT NULL DEFAULT 'unapproved'
          CHECK(contract_status IN ('unapproved','pending','approved','expired','revoked')),
        permitted_use_approved INTEGER NOT NULL DEFAULT 0,
        permitted_uses_json TEXT NOT NULL DEFAULT '[]',
        contract_reference TEXT,
        contract_evidence_sha256 TEXT,
        query_cost_micros INTEGER NOT NULL DEFAULT 0,
        successful_match_cost_micros INTEGER,
        cache_ttl_seconds INTEGER NOT NULL DEFAULT 0,
        retention_days INTEGER NOT NULL DEFAULT 0,
        deletion_obligations TEXT,
        rate_limit_per_minute INTEGER NOT NULL DEFAULT 1,
        secret_env_name TEXT,
        base_url TEXT,
        daily_budget_micros INTEGER NOT NULL DEFAULT 0,
        monthly_budget_micros INTEGER NOT NULL DEFAULT 0,
        circuit_open_until TEXT,
        last_health_at TEXT,
        last_health_status TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, provider_name)
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'UNENRICHED',
        display_name TEXT,
        resident_status TEXT NOT NULL DEFAULT 'VACANT_OR_UNKNOWN',
        owner_name TEXT,
        owner_status TEXT,
        human_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,lead_id)
      );

      CREATE TABLE IF NOT EXISTS phone_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        phone_hash TEXT NOT NULL,
        encrypted_e164 TEXT NOT NULL,
        masked_display TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT 'US',
        original_encrypted TEXT,
        line_type TEXT,
        carrier TEXT,
        validation_status TEXT NOT NULL DEFAULT 'UNVALIDATED',
        reassigned_risk INTEGER NOT NULL DEFAULT 0,
        last_verified_at TEXT,
        verification_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,phone_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_phone_hash ON phone_numbers(tenant_id,phone_hash);

      CREATE TABLE IF NOT EXISTS phone_address_associations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        provider_config_id TEXT REFERENCES contact_enrichment_providers(id) ON DELETE SET NULL,
        provider_record_id TEXT,
        address_confidence REAL NOT NULL DEFAULT 0,
        name_confidence REAL NOT NULL DEFAULT 0,
        phone_confidence REAL NOT NULL DEFAULT 0,
        identity_confidence REAL NOT NULL DEFAULT 0,
        human_verified INTEGER NOT NULL DEFAULT 0,
        resident_status TEXT NOT NULL DEFAULT 'VACANT_OR_UNKNOWN',
        wrong_party INTEGER NOT NULL DEFAULT 0,
        source_age_days INTEGER,
        permitted_use_ref TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,lead_id,phone_id)
      );
      CREATE INDEX IF NOT EXISTS idx_phone_assoc_contact ON phone_address_associations(tenant_id,contact_id,identity_confidence DESC);

      CREATE TABLE IF NOT EXISTS contact_enrichments (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        provider_config_id TEXT REFERENCES contact_enrichment_providers(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        match_count INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        raw_response_encrypted TEXT,
        error_code TEXT,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        expires_at TEXT,
        UNIQUE(tenant_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_enrichment_lead ON contact_enrichments(tenant_id,lead_id,requested_at DESC);

      CREATE TABLE IF NOT EXISTS phone_validations (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE CASCADE,
        provider_config_id TEXT REFERENCES contact_enrichment_providers(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        line_type TEXT,
        reachable INTEGER,
        reassigned_risk INTEGER NOT NULL DEFAULT 0,
        evidence_ref TEXT,
        checked_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_phone_validation_current ON phone_validations(tenant_id,phone_id,expires_at DESC);

      CREATE TABLE IF NOT EXISTS dnc_dataset_versions (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('national','state','vendor')),
        state TEXT,
        version_label TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        source_as_of TEXT NOT NULL,
        source_retrieved_at TEXT NOT NULL,
        effective_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','superseded','failed','revoked')),
        authorized_account_ref TEXT,
        covered_area_codes_json TEXT NOT NULL DEFAULT '[]',
        imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,source_type,state,version_label)
      );
      CREATE INDEX IF NOT EXISTS idx_dnc_dataset_current ON dnc_dataset_versions(tenant_id,source_type,state,status,expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_dataset_version_scope
        ON dnc_dataset_versions(tenant_id,source_type,coalesce(state,''),version_label);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_dataset_one_active
        ON dnc_dataset_versions(tenant_id,source_type,coalesce(state,'')) WHERE status='active';

      CREATE TABLE IF NOT EXISTS dnc_import_jobs (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('national','state')),
        state TEXT,
        version_label TEXT NOT NULL,
        authorized_account_ref TEXT NOT NULL,
        covered_area_codes_json TEXT NOT NULL,
        expected_record_count INTEGER NOT NULL CHECK(expected_record_count>0),
        expected_chunk_count INTEGER NOT NULL CHECK(expected_chunk_count>0),
        chunk_size INTEGER NOT NULL CHECK(chunk_size BETWEEN 1 AND 3000),
        source_manifest_sha256 TEXT NOT NULL,
        manifest_signature_sha256 TEXT NOT NULL,
        source_as_of TEXT NOT NULL,
        source_retrieved_at TEXT NOT NULL,
        max_age_days INTEGER NOT NULL CHECK(max_age_days BETWEEN 1 AND 31),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','finalized','failed','cancelled')),
        dataset_version_id TEXT REFERENCES dnc_dataset_versions(id) ON DELETE SET NULL,
        imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        finalized_at TEXT,
        UNIQUE(tenant_id,source_type,state,version_label)
      );
      CREATE INDEX IF NOT EXISTS idx_dnc_import_status ON dnc_import_jobs(tenant_id,status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_import_version_scope
        ON dnc_import_jobs(tenant_id,source_type,coalesce(state,''),version_label);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_import_signed_manifest
        ON dnc_import_jobs(tenant_id,manifest_signature_sha256);

      CREATE TABLE IF NOT EXISTS dnc_import_chunks (
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        import_id TEXT NOT NULL REFERENCES dnc_import_jobs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
        source_chunk_sha256 TEXT NOT NULL,
        input_count INTEGER NOT NULL,
        accepted_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(tenant_id,import_id,chunk_index)
      );

      CREATE TABLE IF NOT EXISTS dnc_import_staging (
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        import_id TEXT NOT NULL REFERENCES dnc_import_jobs(id) ON DELETE CASCADE,
        phone_hash TEXT NOT NULL,
        PRIMARY KEY(tenant_id,import_id,phone_hash)
      );

      CREATE TABLE IF NOT EXISTS dnc_suppressions (
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        dataset_version_id TEXT NOT NULL REFERENCES dnc_dataset_versions(id) ON DELETE CASCADE,
        phone_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(tenant_id,dataset_version_id,phone_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_dnc_lookup ON dnc_suppressions(tenant_id,phone_hash,dataset_version_id);

      CREATE TABLE IF NOT EXISTS internal_dnc_entries (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        phone_hash TEXT NOT NULL,
        encrypted_e164 TEXT NOT NULL,
        reason TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_ref TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        corrected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        corrected_at TEXT,
        correction_reason TEXT,
        UNIQUE(tenant_id,phone_hash)
      );

      CREATE TABLE IF NOT EXISTS platform_dnc_entries (
        id TEXT PRIMARY KEY,
        phone_hash TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        source_ref TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_dnc_phone ON platform_dnc_entries(phone_hash);

      CREATE TABLE IF NOT EXISTS suppression_events (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        internal_dnc_id TEXT NOT NULL REFERENCES internal_dnc_entries(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        reason TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        previous_event_sha256 TEXT,
        event_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consent_evidence_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        call_attempt_id TEXT REFERENCES call_attempts(id) ON DELETE RESTRICT,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('voice_recording','signed_form','written_record')),
        storage_provider TEXT NOT NULL,
        storage_ref TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        retention_until TEXT NOT NULL,
        verification_method TEXT NOT NULL,
        verification_evidence_ref TEXT NOT NULL,
        manifest_signature_sha256 TEXT NOT NULL,
        verified_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,storage_ref),
        UNIQUE(tenant_id,artifact_sha256)
      );

      CREATE TABLE IF NOT EXISTS consent_records (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        seller TEXT NOT NULL,
        service_address TEXT NOT NULL,
        consumer_identity TEXT NOT NULL,
        consent_type TEXT NOT NULL,
        channels_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        disclosure_version TEXT NOT NULL,
        disclosure_text_sha256 TEXT NOT NULL,
        method TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        affirmative_action TEXT NOT NULL,
        source_url TEXT,
        ip_address TEXT,
        device_metadata_json TEXT,
        evidence_artifact_ref TEXT NOT NULL,
        voice_recording_ref TEXT,
        signature_ref TEXT,
        captured_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        expires_at TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        evidence_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK(length(trim(consumer_identity))>0 AND length(trim(source_ref))>0 AND length(trim(affirmative_action))>0),
        CHECK(voice_recording_ref IS NOT NULL OR signature_ref IS NOT NULL),
        CHECK(method<>'recorded_call' OR voice_recording_ref IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS consent_revocations (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        consent_id TEXT NOT NULL REFERENCES consent_records(id) ON DELETE RESTRICT,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        scope TEXT NOT NULL,
        method TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        revoked_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,consent_id,revoked_at)
      );

      CREATE TABLE IF NOT EXISTS calling_rule_versions (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        rules_sha256 TEXT NOT NULL,
        config_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        counsel_approval_reference TEXT,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_rule_active ON calling_rule_versions(tenant_id) WHERE active=1;

      CREATE TABLE IF NOT EXISTS compliance_decisions (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        rule_version TEXT NOT NULL,
        final_status TEXT NOT NULL,
        eligible INTEGER NOT NULL DEFAULT 0,
        reason_codes_json TEXT NOT NULL,
        rule_results_json TEXT NOT NULL,
        input_evidence_sha256 TEXT NOT NULL,
        input_evidence_json TEXT NOT NULL,
        dnc_dataset_refs_json TEXT NOT NULL DEFAULT '[]',
        provider_contract_ref TEXT,
        registration_ref TEXT,
        script_version TEXT,
        representative_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        local_time TEXT,
        time_zone TEXT,
        evaluated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_latest ON compliance_decisions(tenant_id,lead_id,phone_id,evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS calling_queue_entries (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        phone_id INTEGER REFERENCES phone_numbers(id) ON DELETE SET NULL,
        stage TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        last_decision_id TEXT REFERENCES compliance_decisions(id) ON DELETE SET NULL,
        lease_owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        lease_expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        closed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,lead_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calling_queue_stage ON calling_queue_entries(tenant_id,stage,priority DESC,created_at);

      CREATE TABLE IF NOT EXISTS call_authorizations (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        compliance_decision_id TEXT NOT NULL REFERENCES compliance_decisions(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        nonce_sha256 TEXT NOT NULL UNIQUE,
        token_sha256 TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_call_auth_live ON call_authorizations(tenant_id,user_id,expires_at,used_at,invalidated_at);

      CREATE TABLE IF NOT EXISTS call_attempts (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        authorization_id TEXT NOT NULL UNIQUE REFERENCES call_authorizations(id) ON DELETE RESTRICT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        representative_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        caller_id_reference TEXT NOT NULL,
        script_version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_seconds INTEGER,
        disposition_code TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_call_attempt_frequency ON call_attempts(tenant_id,phone_id,started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_call_attempt_one_open
        ON call_attempts(tenant_id,phone_id) WHERE ended_at IS NULL;

      CREATE TABLE IF NOT EXISTS call_dispositions (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES call_attempts(id) ON DELETE RESTRICT,
        code TEXT NOT NULL,
        notes TEXT,
        effect_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_call_disposition_once
        ON call_dispositions(tenant_id,attempt_id);

      CREATE TABLE IF NOT EXISTS callback_tasks (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        queue_entry_id TEXT NOT NULL REFERENCES calling_queue_entries(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        phone_id INTEGER NOT NULL REFERENCES phone_numbers(id) ON DELETE RESTRICT,
        assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        consent_evidence_ref TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        cancelled_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_callback_due ON callback_tasks(tenant_id,status,due_at);

      CREATE TABLE IF NOT EXISTS calling_opportunities (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        source_attempt_id TEXT REFERENCES call_attempts(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        product_interest TEXT,
        next_step_at TEXT,
        converted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id,lead_id)
      );

      CREATE TABLE IF NOT EXISTS provider_usage_events (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider_config_id TEXT NOT NULL REFERENCES contact_enrichment_providers(id) ON DELETE RESTRICT,
        enrichment_id TEXT REFERENCES contact_enrichments(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        successful_match INTEGER NOT NULL DEFAULT 0,
        compliant_usable_match INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_provider_usage_budget ON provider_usage_events(tenant_id,provider_config_id,created_at);

      CREATE TABLE IF NOT EXISTS calling_audit_events (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        previous_event_sha256 TEXT,
        event_sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calling_audit_tenant ON calling_audit_events(tenant_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calling_audit_previous ON calling_audit_events(tenant_id,previous_event_sha256);

      CREATE TABLE IF NOT EXISTS calling_audit_heads (
        tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
        event_id TEXT,
        event_sha256 TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_internal_dnc_no_delete
      BEFORE DELETE ON internal_dnc_entries BEGIN
        SELECT RAISE(ABORT,'internal_dnc_entries_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_platform_dnc_no_delete
      BEFORE DELETE ON platform_dnc_entries BEGIN
        SELECT RAISE(ABORT,'platform_dnc_entries_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_platform_dnc_no_update
      BEFORE UPDATE ON platform_dnc_entries BEGIN
        SELECT RAISE(ABORT,'platform_dnc_entries_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_calling_representative_hold_no_delete
      BEFORE DELETE ON calling_representative_holds BEGIN
        SELECT RAISE(ABORT,'calling_representative_holds_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_calling_representative_hold_release_only
      BEFORE UPDATE ON calling_representative_holds
      WHEN NEW.id IS NOT OLD.id
        OR NEW.tenant_id IS NOT OLD.tenant_id
        OR NEW.representative_user_id IS NOT OLD.representative_user_id
        OR NEW.reason IS NOT OLD.reason
        OR NEW.placed_by IS NOT OLD.placed_by
        OR NEW.placed_at IS NOT OLD.placed_at
        OR NEW.created_at IS NOT OLD.created_at
        OR OLD.released_at IS NOT NULL
        OR NEW.released_by IS NULL
        OR NEW.release_reason IS NULL
        OR NEW.released_at IS NULL
      BEGIN
        SELECT RAISE(ABORT,'calling_representative_hold_release_transition_only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_internal_dnc_permanent_fields
      BEFORE UPDATE ON internal_dnc_entries
      WHEN NEW.tenant_id IS NOT OLD.tenant_id
        OR NEW.phone_hash IS NOT OLD.phone_hash
        OR NEW.encrypted_e164 IS NOT OLD.encrypted_e164
        OR NEW.reason IS NOT OLD.reason
        OR NEW.channel IS NOT OLD.channel
        OR NEW.source_ref IS NOT OLD.source_ref
        OR NEW.active<>1
        OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT,'internal_dnc_suppression_is_permanent');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_no_update
      BEFORE UPDATE ON consent_records BEGIN
        SELECT RAISE(ABORT,'consent_records_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_no_delete
      BEFORE DELETE ON consent_records BEGIN
        SELECT RAISE(ABORT,'consent_records_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_evidence_required
      BEFORE INSERT ON consent_records
      WHEN length(trim(COALESCE(NEW.consumer_identity,'')))=0
        OR length(trim(COALESCE(NEW.source_ref,'')))=0
        OR length(trim(COALESCE(NEW.affirmative_action,'')))=0
        OR (NEW.voice_recording_ref IS NULL AND NEW.signature_ref IS NULL)
        OR (NEW.method='recorded_call' AND NEW.voice_recording_ref IS NULL)
      BEGIN
        SELECT RAISE(ABORT,'consent_durable_evidence_required');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_calling_audit_no_update
      BEFORE UPDATE ON calling_audit_events BEGIN
        SELECT RAISE(ABORT,'calling_audit_events_are_append_only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_calling_audit_no_delete
      BEFORE DELETE ON calling_audit_events BEGIN
        SELECT RAISE(ABORT,'calling_audit_events_are_append_only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_suppression_event_no_update
      BEFORE UPDATE ON suppression_events BEGIN
        SELECT RAISE(ABORT,'suppression_events_are_append_only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_revocation_no_update
      BEFORE UPDATE ON consent_revocations BEGIN
        SELECT RAISE(ABORT,'consent_revocations_are_append_only');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_artifact_no_update
      BEFORE UPDATE ON consent_evidence_artifacts BEGIN
        SELECT RAISE(ABORT,'consent_evidence_artifacts_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_compliance_decision_no_update
      BEFORE UPDATE ON compliance_decisions BEGIN
        SELECT RAISE(ABORT,'compliance_decisions_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_call_disposition_no_update
      BEFORE UPDATE ON call_dispositions BEGIN
        SELECT RAISE(ABORT,'call_dispositions_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_compliance_decision_retention
      BEFORE DELETE ON compliance_decisions
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_call_authorization_retention
      BEFORE DELETE ON call_authorizations
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_call_attempt_retention
      BEFORE DELETE ON call_attempts
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_call_disposition_retention
      BEFORE DELETE ON call_dispositions
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_suppression_event_retention
      BEFORE DELETE ON suppression_events
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_revocation_retention
      BEFORE DELETE ON consent_revocations
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_consent_artifact_retention
      BEFORE DELETE ON consent_evidence_artifacts
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_provider_usage_retention
      BEFORE DELETE ON provider_usage_events
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
    `);
    // Development/pilot databases may have seen an earlier dark-schema build.
    // Additive compatibility stays inside the same startup transaction.
    const consentColumns = new Set((rawDb.prepare("PRAGMA table_info('consent_records')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!consentColumns.has("affirmative_action")) rawDb.exec("ALTER TABLE consent_records ADD COLUMN affirmative_action TEXT NOT NULL DEFAULT 'legacy_evidence_artifact'");
    if (!consentColumns.has("source_url")) rawDb.exec("ALTER TABLE consent_records ADD COLUMN source_url TEXT");
    if (!consentColumns.has("ip_address")) rawDb.exec("ALTER TABLE consent_records ADD COLUMN ip_address TEXT");
    if (!consentColumns.has("device_metadata_json")) rawDb.exec("ALTER TABLE consent_records ADD COLUMN device_metadata_json TEXT");
    const associationColumns = new Set((rawDb.prepare("PRAGMA table_info('phone_address_associations')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!associationColumns.has("resident_status")) {
      rawDb.exec("ALTER TABLE phone_address_associations ADD COLUMN resident_status TEXT NOT NULL DEFAULT 'VACANT_OR_UNKNOWN'");
    }
    const decisionColumns = new Set((rawDb.prepare("PRAGMA table_info('compliance_decisions')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!decisionColumns.has("input_evidence_json")) {
      rawDb.exec("ALTER TABLE compliance_decisions ADD COLUMN input_evidence_json TEXT NOT NULL DEFAULT '{}'");
    }
    const scriptColumns = new Set((rawDb.prepare("PRAGMA table_info('approved_calling_scripts')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!scriptColumns.has("counsel_approval_reference")) {
      rawDb.exec("ALTER TABLE approved_calling_scripts ADD COLUMN counsel_approval_reference TEXT");
    }
    const ruleColumns = new Set((rawDb.prepare("PRAGMA table_info('calling_rule_versions')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!ruleColumns.has("counsel_approval_reference")) {
      rawDb.exec("ALTER TABLE calling_rule_versions ADD COLUMN counsel_approval_reference TEXT");
    }
    const dncDatasetColumns = new Set((rawDb.prepare("PRAGMA table_info('dnc_dataset_versions')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!dncDatasetColumns.has("source_as_of")) {
      rawDb.exec("ALTER TABLE dnc_dataset_versions ADD COLUMN source_as_of TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    }
    if (!dncDatasetColumns.has("source_retrieved_at")) {
      rawDb.exec("ALTER TABLE dnc_dataset_versions ADD COLUMN source_retrieved_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    }
    if (!dncDatasetColumns.has("created_at")) {
      rawDb.exec("ALTER TABLE dnc_dataset_versions ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    }
    const dncImportColumns = new Set((rawDb.prepare("PRAGMA table_info('dnc_import_jobs')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!dncImportColumns.has("source_as_of")) {
      rawDb.exec("ALTER TABLE dnc_import_jobs ADD COLUMN source_as_of TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    }
    if (!dncImportColumns.has("source_retrieved_at")) {
      rawDb.exec("ALTER TABLE dnc_import_jobs ADD COLUMN source_retrieved_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    }
    if (!dncImportColumns.has("chunk_size")) {
      rawDb.exec("ALTER TABLE dnc_import_jobs ADD COLUMN chunk_size INTEGER NOT NULL DEFAULT 3000");
    }
    const consentArtifactColumns = new Set((rawDb.prepare("PRAGMA table_info('consent_evidence_artifacts')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!consentArtifactColumns.has("storage_provider")) {
      rawDb.exec("ALTER TABLE consent_evidence_artifacts ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'legacy_unverified'");
    }
    if (!consentArtifactColumns.has("verification_method")) {
      rawDb.exec("ALTER TABLE consent_evidence_artifacts ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'legacy_unverified'");
    }
    if (!consentArtifactColumns.has("verification_evidence_ref")) {
      rawDb.exec("ALTER TABLE consent_evidence_artifacts ADD COLUMN verification_evidence_ref TEXT NOT NULL DEFAULT 'legacy_unverified'");
    }
    if (!consentArtifactColumns.has("manifest_signature_sha256")) {
      rawDb.exec("ALTER TABLE consent_evidence_artifacts ADD COLUMN manifest_signature_sha256 TEXT NOT NULL DEFAULT 'legacy_unverified'");
    }
    const profileColumns = new Set((rawDb.prepare("PRAGMA table_info('organization_compliance_profiles')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!profileColumns.has("propagate_opt_out_platform_wide")) {
      rawDb.exec("ALTER TABLE organization_compliance_profiles ADD COLUMN propagate_opt_out_platform_wide INTEGER NOT NULL DEFAULT 0 CHECK(propagate_opt_out_platform_wide IN (0,1))");
    }

    // Resident numbers belong exclusively in the encrypted Calling vault. The
    // historical field-sales lead columns had no provenance, DNC evidence, or
    // retention controls, so they cannot be safely imported. Purge them in the
    // same atomic migration; generic lead write routes reject both fields.
    const leadColumns = new Set((rawDb.prepare("PRAGMA table_info('leads')").all() as Array<{ name: string }>).map((row) => row.name));
    const legacyPhoneColumns = ["contact_phone", "owner_phone"].filter((column) => leadColumns.has(column));
    if (legacyPhoneColumns.length) {
      rawDb.exec(`UPDATE leads SET ${legacyPhoneColumns.map((column) => `${column}=NULL`).join(",")}
        WHERE ${legacyPhoneColumns.map((column) => `${column} IS NOT NULL`).join(" OR ")}`);
    }

    // Early pilot builds scoped the open-attempt lease to a lead. A phone can
    // be associated with more than one lead, so that shape allowed two reps to
    // reveal and call the same resident concurrently. Upgrade the invariant in
    // place, but fail closed if the database already contains conflicting open
    // attempts rather than silently rewriting regulated call history.
    const openAttemptIndex = rawDb.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND name='uq_call_attempt_one_open'`).get() as { sql?: string } | undefined;
    const normalizedOpenAttemptIndex = (openAttemptIndex?.sql ?? "").replace(/\s+/g, "").toLowerCase();
    if (!normalizedOpenAttemptIndex.includes("(tenant_id,phone_id)whereended_atisnull")) {
      const duplicateOpenPhone = rawDb.prepare(`SELECT tenant_id AS tenantId,phone_id AS phoneId,count(*) AS count
        FROM call_attempts WHERE ended_at IS NULL GROUP BY tenant_id,phone_id HAVING count(*)>1 LIMIT 1`)
        .get() as { tenantId: number; phoneId: number; count: number } | undefined;
      if (duplicateOpenPhone) {
        throw new Error(`Calling migration blocked: tenant ${duplicateOpenPhone.tenantId} phone ${duplicateOpenPhone.phoneId} has ${duplicateOpenPhone.count} open attempts`);
      }
      rawDb.exec(`DROP INDEX IF EXISTS uq_call_attempt_one_open;
        CREATE UNIQUE INDEX uq_call_attempt_one_open
        ON call_attempts(tenant_id,phone_id) WHERE ended_at IS NULL;`);
    }

    // These triggers reference columns added by the dark-schema compatibility
    // path above, so install them only after every supported database shape has
    // been upgraded inside this same transaction.
    rawDb.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_dnc_dataset_immutable_evidence
      BEFORE UPDATE ON dnc_dataset_versions
      WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.source_type IS NOT OLD.source_type
        OR NEW.state IS NOT OLD.state OR NEW.version_label IS NOT OLD.version_label
        OR NEW.checksum_sha256 IS NOT OLD.checksum_sha256 OR NEW.record_count IS NOT OLD.record_count
        OR NEW.imported_at IS NOT OLD.imported_at OR NEW.source_as_of IS NOT OLD.source_as_of
        OR NEW.source_retrieved_at IS NOT OLD.source_retrieved_at OR NEW.effective_at IS NOT OLD.effective_at
        OR NEW.expires_at IS NOT OLD.expires_at OR NEW.authorized_account_ref IS NOT OLD.authorized_account_ref
        OR NEW.covered_area_codes_json IS NOT OLD.covered_area_codes_json OR NEW.imported_by IS NOT OLD.imported_by
        OR NEW.created_at IS NOT OLD.created_at
        OR NOT (NEW.status=OLD.status OR (OLD.status='active' AND NEW.status IN ('superseded','revoked')))
      BEGIN SELECT RAISE(ABORT,'dnc_dataset_evidence_is_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS trg_dnc_suppression_no_update
      BEFORE UPDATE ON dnc_suppressions BEGIN
        SELECT RAISE(ABORT,'dnc_suppressions_are_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_dnc_dataset_retention
      BEFORE DELETE ON dnc_dataset_versions
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
      CREATE TRIGGER IF NOT EXISTS trg_dnc_suppression_retention
      BEFORE DELETE ON dnc_suppressions
      WHEN OLD.created_at > datetime('now', printf('-%d years', COALESCE(
        (SELECT retention_years FROM organization_compliance_profiles WHERE tenant_id=OLD.tenant_id),5)))
      BEGIN SELECT RAISE(ABORT,'calling_record_retention_active'); END;
    `);

    rawDb.prepare("INSERT OR IGNORE INTO calling_schema_versions(version) VALUES (?)").run(CALLING_SCHEMA_VERSION);
    const missing = rawDb.prepare(`SELECT name FROM pragma_table_info('call_authorizations')
      WHERE name IN ('nonce_sha256','token_sha256','invalidated_at')`).all() as Array<{ name: string }>;
    if (missing.length !== 3) throw new Error("Calling compliance schema verification failed");
    const callingTables = new Set([
      "organization_compliance_profiles", "seller_authorizations", "state_registrations",
      "calling_representative_holds",
      "approved_calling_scripts", "contact_enrichment_providers", "contacts", "phone_numbers",
      "phone_address_associations", "contact_enrichments", "phone_validations", "dnc_dataset_versions",
      "dnc_import_jobs", "dnc_import_chunks", "dnc_import_staging", "dnc_suppressions", "internal_dnc_entries", "platform_dnc_entries", "suppression_events", "consent_evidence_artifacts", "consent_records",
      "consent_revocations", "calling_rule_versions", "compliance_decisions", "calling_queue_entries",
      "call_authorizations", "call_attempts", "call_dispositions", "callback_tasks",
      "calling_opportunities", "provider_usage_events", "calling_audit_events", "calling_audit_heads",
    ]);
    const foreignKeys = rawDb.prepare("PRAGMA foreign_key_check").all() as Array<{ table?: string }>;
    if (foreignKeys.some((row) => row.table && callingTables.has(row.table))) {
      throw new Error("Calling migration foreign-key verification failed");
    }
    rawDb.exec("COMMIT");
  } catch (error) {
    try { rawDb.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

export function callingSchemaVersion(): string {
  return CALLING_SCHEMA_VERSION;
}

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS calling_schema_versions (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_id ON leads (tenant_id, id);

CREATE TABLE IF NOT EXISTS organization_compliance_profiles (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  calling_enabled boolean NOT NULL DEFAULT false,
  emergency_disabled boolean NOT NULL DEFAULT true,
  counsel_approved boolean NOT NULL DEFAULT false,
  seller_authorized boolean NOT NULL DEFAULT false,
  seller_name text,
  seller_authorization_ref text,
  state_rules_approved boolean NOT NULL DEFAULT false,
  default_time_zone text NOT NULL DEFAULT 'America/New_York',
  allowed_start_local time NOT NULL DEFAULT '08:00',
  allowed_end_local time NOT NULL DEFAULT '21:00',
  minimum_identity_confidence numeric(5,4) NOT NULL DEFAULT 0.85 CHECK (minimum_identity_confidence BETWEEN 0 AND 1),
  max_attempts_7_days integer NOT NULL DEFAULT 2 CHECK (max_attempts_7_days >= 0),
  max_attempts_30_days integer NOT NULL DEFAULT 3 CHECK (max_attempts_30_days >= 0),
  dnc_max_age_days integer NOT NULL DEFAULT 31 CHECK (dnc_max_age_days BETWEEN 1 AND 31),
  allow_national_dnc_consent_override boolean NOT NULL DEFAULT false,
  allow_state_dnc_consent_override boolean NOT NULL DEFAULT false,
  propagate_opt_out_platform_wide boolean NOT NULL DEFAULT false,
  caller_id_authorized boolean NOT NULL DEFAULT false,
  caller_id_reference text,
  retention_years integer NOT NULL DEFAULT 5 CHECK (retention_years >= 5),
  policy_version integer NOT NULL DEFAULT 1,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calling_users_tenant_id ON users (tenant_id,id);

CREATE TABLE IF NOT EXISTS calling_representative_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  representative_user_id integer NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  placed_by integer NOT NULL,
  placed_at timestamptz NOT NULL,
  released_by integer,
  release_reason text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,representative_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,placed_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,released_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (
    (released_by IS NULL AND release_reason IS NULL AND released_at IS NULL)
    OR
    (released_by IS NOT NULL AND release_reason IS NOT NULL
      AND length(btrim(release_reason)) BETWEEN 3 AND 1000 AND released_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calling_representative_active_hold
  ON calling_representative_holds (tenant_id,representative_user_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calling_representative_hold_history
  ON calling_representative_holds (tenant_id,representative_user_id,placed_at DESC);

CREATE TABLE IF NOT EXISTS seller_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seller_name text NOT NULL,
  authorization_ref text NOT NULL,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('pending','active','expired','revoked')),
  evidence_sha256 char(64) NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, authorization_ref),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS state_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state char(2) NOT NULL,
  legal_entity text NOT NULL,
  registration_type text NOT NULL CHECK (registration_type IN ('registration','documented_exemption')),
  registration_number text,
  exemption_type text,
  evidence_ref text NOT NULL,
  counsel_approved boolean NOT NULL DEFAULT false,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  last_reviewed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','expired','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, state, registration_type, evidence_ref),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_state_registrations_active
  ON state_registrations (tenant_id, state, status, expires_at);

CREATE TABLE IF NOT EXISTS approved_calling_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  disclosure_sha256 char(64) NOT NULL,
  seller_name text NOT NULL,
  company_name text NOT NULL,
  purpose text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  counsel_approved boolean NOT NULL DEFAULT false,
  counsel_approval_reference text,
  approved_by integer REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_script_active
  ON approved_calling_scripts (tenant_id) WHERE active;

CREATE TABLE IF NOT EXISTS contact_enrichment_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_name text NOT NULL,
  adapter_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  contract_status text NOT NULL DEFAULT 'unapproved' CHECK (contract_status IN ('unapproved','pending','approved','expired','revoked')),
  permitted_use_approved boolean NOT NULL DEFAULT false,
  permitted_uses_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permitted_uses_json) = 'array'),
  contract_reference text,
  contract_evidence_sha256 char(64),
  query_cost_micros bigint NOT NULL DEFAULT 0 CHECK (query_cost_micros >= 0),
  successful_match_cost_micros bigint CHECK (successful_match_cost_micros >= 0),
  cache_ttl_seconds integer NOT NULL DEFAULT 0 CHECK (cache_ttl_seconds >= 0),
  retention_days integer NOT NULL DEFAULT 0 CHECK (retention_days >= 0),
  deletion_obligations text,
  rate_limit_per_minute integer NOT NULL DEFAULT 1 CHECK (rate_limit_per_minute > 0),
  secret_env_name text,
  base_url text,
  daily_budget_micros bigint NOT NULL DEFAULT 0 CHECK (daily_budget_micros >= 0),
  monthly_budget_micros bigint NOT NULL DEFAULT 0 CHECK (monthly_budget_micros >= 0),
  circuit_open_until timestamptz,
  last_health_at timestamptz,
  last_health_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  status text NOT NULL DEFAULT 'UNENRICHED',
  display_name text,
  resident_status text NOT NULL DEFAULT 'VACANT_OR_UNKNOWN',
  owner_name text,
  owner_status text,
  human_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash char(64) NOT NULL,
  encrypted_e164 text NOT NULL,
  masked_display text NOT NULL,
  country char(2) NOT NULL DEFAULT 'US',
  original_encrypted text,
  line_type text,
  carrier text,
  validation_status text NOT NULL DEFAULT 'UNVALIDATED',
  reassigned_risk boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  verification_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS phone_address_associations (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL,
  phone_id bigint NOT NULL,
  lead_id integer NOT NULL,
  provider_config_id uuid,
  provider_record_id text,
  address_confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK (address_confidence BETWEEN 0 AND 1),
  name_confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK (name_confidence BETWEEN 0 AND 1),
  phone_confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK (phone_confidence BETWEEN 0 AND 1),
  identity_confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK (identity_confidence BETWEEN 0 AND 1),
  human_verified boolean NOT NULL DEFAULT false,
  resident_status text NOT NULL DEFAULT 'VACANT_OR_UNKNOWN',
  wrong_party boolean NOT NULL DEFAULT false,
  source_age_days integer CHECK (source_age_days >= 0),
  permitted_use_ref text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id, phone_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, provider_config_id) REFERENCES contact_enrichment_providers(tenant_id, id)
    ON DELETE SET NULL (provider_config_id)
);
CREATE INDEX IF NOT EXISTS idx_phone_assoc_contact
  ON phone_address_associations (tenant_id, contact_id, identity_confidence DESC);

CREATE TABLE IF NOT EXISTS contact_enrichments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  contact_id bigint,
  provider_config_id uuid,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  match_count integer NOT NULL DEFAULT 0 CHECK (match_count >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  cache_hit boolean NOT NULL DEFAULT false,
  raw_response_encrypted text,
  error_code text,
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, provider_config_id) REFERENCES contact_enrichment_providers(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_enrichment_lead ON contact_enrichments (tenant_id, lead_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS phone_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_id bigint NOT NULL,
  provider_config_id uuid,
  status text NOT NULL,
  line_type text,
  reachable boolean,
  reassigned_risk boolean NOT NULL DEFAULT false,
  evidence_ref text,
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, provider_config_id) REFERENCES contact_enrichment_providers(tenant_id, id)
    ON DELETE SET NULL (provider_config_id)
);
CREATE INDEX IF NOT EXISTS idx_phone_validation_current ON phone_validations (tenant_id, phone_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS dnc_dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('national','state','vendor')),
  state char(2),
  version_label text NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  record_count integer NOT NULL CHECK (record_count >= 0),
  imported_at timestamptz NOT NULL,
  source_as_of timestamptz NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','superseded','failed','revoked')),
  authorized_account_ref text,
  covered_area_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(covered_area_codes_json) = 'array'),
  imported_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, state, version_label),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_dnc_dataset_current ON dnc_dataset_versions (tenant_id, source_type, state, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_dataset_version_scope
  ON dnc_dataset_versions (tenant_id, source_type, coalesce(state,''), version_label);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_dataset_one_active
  ON dnc_dataset_versions (tenant_id, source_type, coalesce(state,'')) WHERE status='active';

CREATE TABLE IF NOT EXISTS dnc_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('national','state')),
  state char(2),
  version_label text NOT NULL,
  authorized_account_ref text NOT NULL,
  covered_area_codes_json jsonb NOT NULL CHECK (jsonb_typeof(covered_area_codes_json)='array'),
  expected_record_count bigint NOT NULL CHECK (expected_record_count>0),
  expected_chunk_count integer NOT NULL CHECK (expected_chunk_count>0),
  chunk_size integer NOT NULL CHECK (chunk_size BETWEEN 1 AND 3000),
  source_manifest_sha256 char(64) NOT NULL,
  manifest_signature_sha256 char(64) NOT NULL,
  source_as_of timestamptz NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  max_age_days integer NOT NULL CHECK (max_age_days BETWEEN 1 AND 31),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','finalized','failed','cancelled')),
  dataset_version_id uuid,
  imported_by integer REFERENCES users(id) ON DELETE SET NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (tenant_id,source_type,state,version_label),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,dataset_version_id) REFERENCES dnc_dataset_versions(tenant_id,id)
    ON DELETE SET NULL (dataset_version_id)
);
CREATE INDEX IF NOT EXISTS idx_dnc_import_status ON dnc_import_jobs (tenant_id,status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_import_version_scope
  ON dnc_import_jobs (tenant_id,source_type,coalesce(state,''),version_label);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_import_signed_manifest
  ON dnc_import_jobs (tenant_id,manifest_signature_sha256);

CREATE TABLE IF NOT EXISTS dnc_import_chunks (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index>=0),
  source_chunk_sha256 char(64) NOT NULL,
  input_count integer NOT NULL CHECK (input_count>=0),
  accepted_count integer NOT NULL CHECK (accepted_count>=0),
  rejected_count integer NOT NULL CHECK (rejected_count>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,import_id,chunk_index),
  FOREIGN KEY (tenant_id,import_id) REFERENCES dnc_import_jobs(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dnc_import_staging (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_id uuid NOT NULL,
  phone_hash char(64) NOT NULL,
  PRIMARY KEY (tenant_id,import_id,phone_hash),
  FOREIGN KEY (tenant_id,import_id) REFERENCES dnc_import_jobs(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dnc_suppressions (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dataset_version_id uuid NOT NULL,
  phone_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dataset_version_id, phone_hash),
  FOREIGN KEY (tenant_id, dataset_version_id) REFERENCES dnc_dataset_versions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dnc_lookup ON dnc_suppressions (tenant_id, phone_hash, dataset_version_id);

CREATE TABLE IF NOT EXISTS internal_dnc_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash char(64) NOT NULL,
  encrypted_e164 text NOT NULL,
  reason text NOT NULL,
  channel text NOT NULL,
  source_ref text,
  active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  corrected_by integer REFERENCES users(id) ON DELETE SET NULL,
  corrected_at timestamptz,
  correction_reason text,
  UNIQUE (tenant_id, phone_hash),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS platform_dnc_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash char(64) NOT NULL UNIQUE,
  reason text NOT NULL,
  channel text NOT NULL,
  source_tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_ref text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_dnc_source
  ON platform_dnc_entries (source_tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppression_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  internal_dnc_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  channel text NOT NULL,
  reason text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  previous_event_sha256 char(64),
  event_sha256 char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, internal_dnc_id) REFERENCES internal_dnc_entries(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer,
  contact_id bigint,
  phone_id bigint NOT NULL,
  seller text NOT NULL,
  service_address text NOT NULL,
  consumer_identity text NOT NULL,
  consent_type text NOT NULL,
  channels_json jsonb NOT NULL CHECK (jsonb_typeof(channels_json) = 'array'),
  scope text NOT NULL,
  disclosure_version text NOT NULL,
  disclosure_text_sha256 char(64) NOT NULL,
  method text NOT NULL,
  source_ref text NOT NULL,
  affirmative_action text NOT NULL,
  source_url text,
  evidence_artifact_ref text NOT NULL,
  voice_recording_ref text,
  signature_ref text,
  ip_address inet,
  device_metadata_json jsonb,
  captured_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  expires_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  evidence_sha256 char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(consumer_identity)) > 0 AND length(btrim(source_ref)) > 0 AND length(btrim(affirmative_action)) > 0),
  CHECK (voice_recording_ref IS NOT NULL OR signature_ref IS NOT NULL),
  CHECK (method <> 'recorded_call' OR voice_recording_ref IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE SET NULL (lead_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS consent_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consent_id uuid NOT NULL,
  phone_id bigint NOT NULL,
  scope text NOT NULL,
  method text NOT NULL,
  evidence_ref text NOT NULL,
  revoked_at timestamptz NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, consent_id, revoked_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consent_records(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS calling_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version text NOT NULL,
  rules_sha256 char(64) NOT NULL,
  config_json jsonb NOT NULL CHECK (jsonb_typeof(config_json) = 'object'),
  active boolean NOT NULL DEFAULT false,
  counsel_approval_reference text,
  approved_by integer REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calling_rule_active ON calling_rule_versions (tenant_id) WHERE active;

CREATE TABLE IF NOT EXISTS compliance_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  contact_id bigint NOT NULL,
  phone_id bigint NOT NULL,
  rule_version text NOT NULL,
  final_status text NOT NULL,
  eligible boolean NOT NULL DEFAULT false,
  reason_codes_json jsonb NOT NULL CHECK (jsonb_typeof(reason_codes_json) = 'array'),
  rule_results_json jsonb NOT NULL CHECK (jsonb_typeof(rule_results_json) = 'array'),
  input_evidence_sha256 char(64) NOT NULL,
  input_evidence_json jsonb NOT NULL CHECK (jsonb_typeof(input_evidence_json)='object'),
  dnc_dataset_refs_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dnc_dataset_refs_json) = 'array'),
  provider_contract_ref text,
  registration_ref text,
  script_version text,
  representative_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  local_time text,
  time_zone text,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_compliance_latest ON compliance_decisions (tenant_id, lead_id, phone_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS calling_queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  contact_id bigint,
  phone_id bigint,
  stage text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  assigned_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  last_decision_id uuid,
  lease_owner_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE SET NULL (phone_id),
  FOREIGN KEY (tenant_id, last_decision_id) REFERENCES compliance_decisions(tenant_id, id)
    ON DELETE SET NULL (last_decision_id)
);
CREATE INDEX IF NOT EXISTS idx_calling_queue_stage ON calling_queue_entries (tenant_id, stage, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS call_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lead_id integer NOT NULL,
  contact_id bigint NOT NULL,
  phone_id bigint NOT NULL,
  compliance_decision_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('reveal_and_hand_dial','copy_number','click_to_call')),
  nonce_sha256 char(64) NOT NULL UNIQUE,
  token_sha256 char(64) NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, compliance_decision_id) REFERENCES compliance_decisions(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_call_auth_live ON call_authorizations (tenant_id, user_id, expires_at, used_at, invalidated_at);

CREATE TABLE IF NOT EXISTS call_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL,
  lead_id integer NOT NULL,
  contact_id bigint NOT NULL,
  phone_id bigint NOT NULL,
  representative_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  caller_id_reference text NOT NULL,
  script_version text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds >= 0),
  disposition_code text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (authorization_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, authorization_id) REFERENCES call_authorizations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_call_attempt_frequency ON call_attempts (tenant_id, phone_id, started_at DESC);
-- Rebuild the pilot index in place. If duplicate open attempts already exist,
-- CREATE fails and the surrounding transaction restores the prior index/data.
DROP INDEX IF EXISTS uq_call_attempt_one_open;
CREATE UNIQUE INDEX uq_call_attempt_one_open
  ON call_attempts (tenant_id,phone_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS consent_evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  phone_id bigint NOT NULL,
  call_attempt_id uuid,
  artifact_type text NOT NULL CHECK (artifact_type IN ('voice_recording','signed_form','written_record')),
  storage_provider text NOT NULL,
  storage_ref text NOT NULL,
  artifact_sha256 char(64) NOT NULL,
  captured_at timestamptz NOT NULL,
  retention_until timestamptz NOT NULL,
  verification_method text NOT NULL,
  verification_evidence_ref text NOT NULL,
  manifest_signature_sha256 char(64) NOT NULL,
  verified_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,storage_ref),
  UNIQUE (tenant_id,artifact_sha256),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,lead_id) REFERENCES leads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,phone_id) REFERENCES phone_numbers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,call_attempt_id) REFERENCES call_attempts(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS call_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  code text NOT NULL,
  notes text,
  effect_json jsonb NOT NULL CHECK (jsonb_typeof(effect_json) = 'object'),
  idempotency_key text NOT NULL,
  created_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES call_attempts(tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_disposition_once
  ON call_dispositions (tenant_id, attempt_id);

CREATE TABLE IF NOT EXISTS callback_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_entry_id uuid NOT NULL,
  lead_id integer NOT NULL,
  phone_id bigint NOT NULL,
  assigned_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  consent_evidence_ref text,
  status text NOT NULL DEFAULT 'scheduled',
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, queue_entry_id) REFERENCES calling_queue_entries(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, phone_id) REFERENCES phone_numbers(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_callback_due ON callback_tasks (tenant_id, status, due_at);

CREATE TABLE IF NOT EXISTS calling_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id integer NOT NULL,
  contact_id bigint,
  source_attempt_id uuid,
  status text NOT NULL,
  assigned_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  product_interest text,
  next_step_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, source_attempt_id) REFERENCES call_attempts(tenant_id, id)
    ON DELETE SET NULL (source_attempt_id)
);

CREATE TABLE IF NOT EXISTS provider_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_config_id uuid NOT NULL,
  enrichment_id uuid,
  event_type text NOT NULL,
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  cache_hit boolean NOT NULL DEFAULT false,
  successful_match boolean NOT NULL DEFAULT false,
  compliant_usable_match boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_config_id) REFERENCES contact_enrichment_providers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, enrichment_id) REFERENCES contact_enrichments(tenant_id, id)
    ON DELETE SET NULL (enrichment_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_usage_budget ON provider_usage_events (tenant_id, provider_config_id, created_at);

CREATE TABLE IF NOT EXISTS calling_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  correlation_id text NOT NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  previous_event_sha256 char(64),
  event_sha256 char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_calling_audit_tenant ON calling_audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calling_audit_previous ON calling_audit_events (tenant_id, previous_event_sha256);

CREATE TABLE IF NOT EXISTS calling_audit_heads (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  event_id uuid,
  event_sha256 char(64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_id IS NULL) = (event_sha256 IS NULL)),
  FOREIGN KEY (tenant_id, event_id) REFERENCES calling_audit_events(tenant_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION calling_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23000';
END;
$$;

CREATE OR REPLACE FUNCTION calling_guard_representative_hold_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.representative_user_id IS DISTINCT FROM OLD.representative_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.placed_by IS DISTINCT FROM OLD.placed_by
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.released_at IS NOT NULL
     OR NEW.released_by IS NULL
     OR NEW.release_reason IS NULL
     OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'calling_representative_hold_release_transition_only' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calling_representative_hold_no_delete ON calling_representative_holds;
CREATE TRIGGER trg_calling_representative_hold_no_delete BEFORE DELETE ON calling_representative_holds
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_calling_representative_hold_release_only ON calling_representative_holds;
CREATE TRIGGER trg_calling_representative_hold_release_only BEFORE UPDATE ON calling_representative_holds
FOR EACH ROW EXECUTE FUNCTION calling_guard_representative_hold_update();

DROP TRIGGER IF EXISTS trg_internal_dnc_no_delete ON internal_dnc_entries;
CREATE TRIGGER trg_internal_dnc_no_delete BEFORE DELETE ON internal_dnc_entries
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

DROP TRIGGER IF EXISTS trg_platform_dnc_no_delete ON platform_dnc_entries;
CREATE TRIGGER trg_platform_dnc_no_delete BEFORE DELETE ON platform_dnc_entries
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_platform_dnc_no_update ON platform_dnc_entries;
CREATE TRIGGER trg_platform_dnc_no_update BEFORE UPDATE ON platform_dnc_entries
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

CREATE OR REPLACE FUNCTION calling_guard_internal_dnc_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.phone_hash IS DISTINCT FROM OLD.phone_hash
     OR NEW.encrypted_e164 IS DISTINCT FROM OLD.encrypted_e164
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.active IS DISTINCT FROM true
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'internal DNC suppression fields are permanent' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_internal_dnc_permanent_fields ON internal_dnc_entries;
CREATE TRIGGER trg_internal_dnc_permanent_fields BEFORE UPDATE ON internal_dnc_entries
FOR EACH ROW EXECUTE FUNCTION calling_guard_internal_dnc_update();

DROP TRIGGER IF EXISTS trg_consent_no_update ON consent_records;
CREATE TRIGGER trg_consent_no_update BEFORE UPDATE ON consent_records
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_consent_no_delete ON consent_records;
CREATE TRIGGER trg_consent_no_delete BEFORE DELETE ON consent_records
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

DROP TRIGGER IF EXISTS trg_calling_audit_no_update ON calling_audit_events;
CREATE TRIGGER trg_calling_audit_no_update BEFORE UPDATE ON calling_audit_events
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_calling_audit_no_delete ON calling_audit_events;
CREATE TRIGGER trg_calling_audit_no_delete BEFORE DELETE ON calling_audit_events
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

DROP TRIGGER IF EXISTS trg_suppression_event_no_update ON suppression_events;
CREATE TRIGGER trg_suppression_event_no_update BEFORE UPDATE ON suppression_events
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_consent_revocation_no_update ON consent_revocations;
CREATE TRIGGER trg_consent_revocation_no_update BEFORE UPDATE ON consent_revocations
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_consent_artifact_no_update ON consent_evidence_artifacts;
CREATE TRIGGER trg_consent_artifact_no_update BEFORE UPDATE ON consent_evidence_artifacts
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_compliance_decision_no_update ON compliance_decisions;
CREATE TRIGGER trg_compliance_decision_no_update BEFORE UPDATE ON compliance_decisions
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();
DROP TRIGGER IF EXISTS trg_call_disposition_no_update ON call_dispositions;
CREATE TRIGGER trg_call_disposition_no_update BEFORE UPDATE ON call_dispositions
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

CREATE OR REPLACE FUNCTION calling_guard_dnc_dataset_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.version_label IS DISTINCT FROM OLD.version_label
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
     OR NEW.record_count IS DISTINCT FROM OLD.record_count
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at
     OR NEW.source_as_of IS DISTINCT FROM OLD.source_as_of
     OR NEW.source_retrieved_at IS DISTINCT FROM OLD.source_retrieved_at
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.authorized_account_ref IS DISTINCT FROM OLD.authorized_account_ref
     OR NEW.covered_area_codes_json IS DISTINCT FROM OLD.covered_area_codes_json
     OR NEW.imported_by IS DISTINCT FROM OLD.imported_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NOT (NEW.status = OLD.status OR (OLD.status='active' AND NEW.status IN ('superseded','revoked'))) THEN
    RAISE EXCEPTION 'DNC dataset evidence is immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dnc_dataset_immutable_evidence ON dnc_dataset_versions;
CREATE TRIGGER trg_dnc_dataset_immutable_evidence BEFORE UPDATE ON dnc_dataset_versions
FOR EACH ROW EXECUTE FUNCTION calling_guard_dnc_dataset_update();
DROP TRIGGER IF EXISTS trg_dnc_suppression_no_update ON dnc_suppressions;
CREATE TRIGGER trg_dnc_suppression_no_update BEFORE UPDATE ON dnc_suppressions
FOR EACH ROW EXECUTE FUNCTION calling_reject_mutation();

CREATE OR REPLACE FUNCTION calling_enforce_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  keep_years integer;
BEGIN
  SELECT COALESCE(retention_years, 5) INTO keep_years
  FROM organization_compliance_profiles WHERE tenant_id = OLD.tenant_id;
  keep_years := GREATEST(COALESCE(keep_years, 5), 5);
  IF OLD.created_at > now() - make_interval(years => keep_years) THEN
    RAISE EXCEPTION '% is within the required retention window', TG_TABLE_NAME USING ERRCODE = '23000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_compliance_decision_retention ON compliance_decisions;
CREATE TRIGGER trg_compliance_decision_retention BEFORE DELETE ON compliance_decisions
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_call_authorization_retention ON call_authorizations;
CREATE TRIGGER trg_call_authorization_retention BEFORE DELETE ON call_authorizations
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_call_attempt_retention ON call_attempts;
CREATE TRIGGER trg_call_attempt_retention BEFORE DELETE ON call_attempts
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_call_disposition_retention ON call_dispositions;
CREATE TRIGGER trg_call_disposition_retention BEFORE DELETE ON call_dispositions
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_suppression_event_retention ON suppression_events;
CREATE TRIGGER trg_suppression_event_retention BEFORE DELETE ON suppression_events
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_consent_revocation_retention ON consent_revocations;
CREATE TRIGGER trg_consent_revocation_retention BEFORE DELETE ON consent_revocations
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_consent_artifact_retention ON consent_evidence_artifacts;
CREATE TRIGGER trg_consent_artifact_retention BEFORE DELETE ON consent_evidence_artifacts
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_dnc_dataset_retention ON dnc_dataset_versions;
CREATE TRIGGER trg_dnc_dataset_retention BEFORE DELETE ON dnc_dataset_versions
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_dnc_suppression_retention ON dnc_suppressions;
CREATE TRIGGER trg_dnc_suppression_retention BEFORE DELETE ON dnc_suppressions
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();
DROP TRIGGER IF EXISTS trg_provider_usage_retention ON provider_usage_events;
CREATE TRIGGER trg_provider_usage_retention BEFORE DELETE ON provider_usage_events
FOR EACH ROW EXECUTE FUNCTION calling_enforce_retention();

INSERT INTO calling_schema_versions(version)
VALUES ('2026-07-14-calling-v4')
ON CONFLICT (version) DO NOTHING;

-- The generic field-sales lead table is not an authorized resident-phone
-- store. Existing values have no Calling provenance/DNC chain, so purge rather
-- than silently importing them into the regulated vault.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='leads' AND column_name='contact_phone') THEN
    EXECUTE 'UPDATE leads SET contact_phone=NULL WHERE contact_phone IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='leads' AND column_name='owner_phone') THEN
    EXECUTE 'UPDATE leads SET owner_phone=NULL WHERE owner_phone IS NOT NULL';
  END IF;
END $$;

COMMIT;

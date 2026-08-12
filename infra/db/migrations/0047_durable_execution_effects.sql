-- Logical effects outlive a short-lived authorization admission. A remote outcome
-- cannot be made atomic with this insert, so an existing provider effect is always
-- treated as unknown and is never dispatched again.
CREATE TABLE IF NOT EXISTS execution_effects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    work_kind TEXT NOT NULL CHECK (work_kind IN ('optimization', 'experiment_task')),
    work_id UUID NOT NULL,
    effect TEXT NOT NULL CHECK (effect IN (
        'provider_dispatch',
        'trace_write',
        'metric_write',
        'result_write',
        'event_write'
    )),
    operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 512),
    first_admission_id UUID REFERENCES execution_admissions(id) ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT execution_effects_project_scope_fkey
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT execution_effects_logical_operation_unique
        UNIQUE (organization_id, project_id, work_kind, work_id, effect, operation_key)
);

ALTER TABLE execution_admission_claims
    ADD COLUMN IF NOT EXISTS execution_effect_id UUID;

-- Historical claims were unique only per admission. Coalesce same-work historical
-- keys into one durable effect without rewriting either claim or tenant provenance.
INSERT INTO execution_effects (
    organization_id,
    project_id,
    work_kind,
    work_id,
    effect,
    operation_key,
    first_admission_id,
    claimed_at
)
SELECT DISTINCT ON (
    admission.organization_id,
    admission.project_id,
    admission.work_kind,
    admission.work_id,
    claim.effect,
    claim.effect_key
)
    admission.organization_id,
    admission.project_id,
    admission.work_kind,
    admission.work_id,
    claim.effect,
    claim.effect_key,
    admission.id,
    claim.claimed_at
FROM execution_admission_claims AS claim
JOIN execution_admissions AS admission ON admission.id = claim.admission_id
ORDER BY
    admission.organization_id,
    admission.project_id,
    admission.work_kind,
    admission.work_id,
    claim.effect,
    claim.effect_key,
    claim.claimed_at,
    claim.id
ON CONFLICT (organization_id, project_id, work_kind, work_id, effect, operation_key)
DO NOTHING;

UPDATE execution_admission_claims AS claim
SET execution_effect_id = effect.id
FROM execution_admissions AS admission,
     execution_effects AS effect
WHERE claim.admission_id = admission.id
  AND effect.organization_id = admission.organization_id
  AND effect.project_id = admission.project_id
  AND effect.work_kind = admission.work_kind
  AND effect.work_id = admission.work_id
  AND effect.effect = claim.effect
  AND effect.operation_key = claim.effect_key
  AND claim.execution_effect_id IS NULL;

ALTER TABLE execution_admission_claims
    ALTER COLUMN execution_effect_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'execution_admission_claims'::regclass
          AND conname = 'execution_admission_claims_execution_effect_fkey'
    ) THEN
        ALTER TABLE execution_admission_claims
            ADD CONSTRAINT execution_admission_claims_execution_effect_fkey
            FOREIGN KEY (execution_effect_id)
            REFERENCES execution_effects(id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS execution_admission_claims_effect_once_idx
    ON execution_admission_claims (admission_id, execution_effect_id);

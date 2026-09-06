-- P3.1 establishes reusable Evaluation identities and immutable definitions.
CREATE TABLE IF NOT EXISTS evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description TEXT CHECK (description IS NULL OR length(description) <= 1000),
    created_by UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, slug),
    UNIQUE (id, project_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_definition_drafts (
    evaluation_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    evaluator JSONB NOT NULL,
    target JSONB NOT NULL,
    execution_defaults JSONB NOT NULL,
    thresholds JSONB NOT NULL,
    dataset_version_id UUID NOT NULL,
    updated_by UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id) REFERENCES evaluations(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, dataset_version_id) REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_definition_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    dataset_version_id UUID NOT NULL,
    evaluator JSONB NOT NULL,
    target JSONB NOT NULL,
    execution_defaults JSONB NOT NULL,
    thresholds JSONB NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    published_by UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    published_draft_revision INTEGER NOT NULL CHECK (published_draft_revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (evaluation_id, version),
    UNIQUE (evaluation_id, content_hash),
    UNIQUE (id, project_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id) REFERENCES evaluations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_version_id) REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_legacy_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    legacy_kind TEXT NOT NULL CHECK (legacy_kind IN ('experiment', 'benchmark_suite')),
    legacy_id UUID NOT NULL,
    dataset_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, legacy_kind, legacy_id),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    evaluation_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'draft_updated', 'definition_published')),
    definition_version_id UUID,
    content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id) REFERENCES evaluations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (definition_version_id, project_id) REFERENCES evaluation_definition_versions(id, project_id) ON DELETE RESTRICT
);

INSERT INTO evaluation_legacy_links (organization_id, project_id, legacy_kind, legacy_id, dataset_id, created_at)
SELECT p.organization_id, e.project_id, 'experiment', e.id, e.dataset_id, e.created_at FROM experiments e JOIN projects p ON p.id = e.project_id
ON CONFLICT (project_id, legacy_kind, legacy_id) DO NOTHING;
INSERT INTO evaluation_legacy_links (organization_id, project_id, legacy_kind, legacy_id, dataset_id, created_at)
SELECT p.organization_id, b.project_id, 'benchmark_suite', b.id, b.dataset_id, b.created_at FROM benchmark_suites b JOIN projects p ON p.id = b.project_id
ON CONFLICT (project_id, legacy_kind, legacy_id) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_evaluation_definition_version_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'evaluation definition versions are immutable' USING ERRCODE = '55000';
END $$;
DROP TRIGGER IF EXISTS evaluation_definition_versions_immutable ON evaluation_definition_versions;
CREATE TRIGGER evaluation_definition_versions_immutable
BEFORE UPDATE OR DELETE ON evaluation_definition_versions
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_definition_version_mutation();

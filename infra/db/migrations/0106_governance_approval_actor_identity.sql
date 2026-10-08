-- Retain an unambiguous durable actor identity for new governance approvals.
-- Legacy approvals keep NULL and are resolved conservatively from actor_subject.
ALTER TABLE governance_policy_approvals
    ADD COLUMN IF NOT EXISTS approved_by_actor_id UUID
    REFERENCES actors(id) ON DELETE RESTRICT;

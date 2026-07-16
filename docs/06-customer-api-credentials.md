# Customer API Credentials

Customer API credentials are project-bound opaque bearer secrets created and revoked by an authenticated user in **Settings**. They are not JWTs: the API has no existing JWT dependency, and opaque credentials avoid a second token format and user-controlled claims.

Creation returns a random `astraea_ck_...` secret exactly once. Astraea stores only its SHA-256 hash, a non-secret display prefix, and a short hash fingerprint. Secrets must not be put in URLs, browser storage, logs, or query caches.

Use the secret directly:

```http
Authorization: Bearer astraea_ck_...
```

The customer route surface is deliberately separate from the internal Basic Auth API:

- `GET /v1/customer/prompts` requires `prompts:read`
- `GET /v1/customer/prompts/{id}` requires `prompts:read`
- `GET /v1/customer/prompts/{id}/versions` requires `prompts:read`
- `POST /v1/customer/prompts/{id}/render` requires `prompts:render`
- `POST /v1/customer/prompts` and `POST /v1/customer/prompts/{id}/versions` require `prompts:write`

Customer routes do not accept `project_id`; the project is derived from the validated credential before repository access. They cannot access internal prompt routes, traces, OTLP, datasets, experiments, scores, agents, projects, administration, prompt provenance, draft preview, or prompt deletion. Revoked and expired credentials fail authentication, and successful use updates `last_used_at`.

// Boots the OpenAPIHono app in-process and writes a stable OpenAPI 3.1 YAML
// snapshot to /openapi.yaml. Idempotent (running twice produces no diff).
//
// Usage: bun run apps/api/openapi:snapshot  (or `make openapi-snapshot`)

import { dump as yamlDump } from "js-yaml";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openapiApp } from "../../apps/api/src/openapi.ts";

const OUT_PATH = resolve(process.cwd(), "openapi.yaml");

const doc = openapiApp.getOpenAPI31Document({
  openapi: "3.1.0",
  info: {
    title: "Astraea API",
    version: "0.1.0",
    description: "Agent and LLM evaluation platform.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local dev" }],
});

// Stable serialization: sort keys recursively, no anchors, lineWidth -1.
const yaml = yamlDump(doc, { sortKeys: true, lineWidth: -1, noRefs: true, noCompatMode: true });

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, yaml, "utf8");

console.log(`✓ OpenAPI snapshot written to ${OUT_PATH} (${yaml.length} bytes)`);
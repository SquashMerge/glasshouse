import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";

// Bun's serve with a single fetch handler that routes both /v1/* and /health/* to openapiApp,
// while preserving /openapi.json and /reference mounted inside openapiApp itself.
const PORT = Number(process.env.API_PORT ?? 3000);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: async (req) => {
    const url = new URL(req.url);
    // /health alias for ops convenience (also exposed under /v1/health via openapiApp).
    if (url.pathname === "/health") return handleHealth();
    return openapiApp.fetch(req);
  },
});

console.log(`✓ Astraea API listening on :${server.port}`);
console.log(`  OpenAPI JSON: http://localhost:${server.port}/openapi.json`);
console.log(`  OpenAPI ref:  http://localhost:${server.port}/reference`);
console.log(`  Health:       http://localhost:${server.port}/health`);
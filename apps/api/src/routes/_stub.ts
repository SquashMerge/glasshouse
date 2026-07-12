import type { ErrorCode } from "../schemas/common.js";

export function notImplemented(): Response {
  const body = JSON.stringify({
    code: "NOT_IMPLEMENTED" as ErrorCode,
    message: "Not implemented",
  });
  return new Response(body, {
    status: 501,
    headers: { "content-type": "application/json" },
  });
}
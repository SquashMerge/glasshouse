FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache bash git make python3 py3-pip nodejs icu-data-full

RUN node -e 'const assert = require("node:assert/strict"); \
    const [major, minor] = process.versions.node.split(".").map(Number); \
    assert(!process.versions.bun && (major > 22 || (major === 22 && minor >= 12))); \
    assert.equal(Intl.DateTimeFormat.supportedLocalesOf(["en", "fr", "ja"]).length, 3); \
    new EventTarget().addEventListener("test", () => {});'

USER bun
WORKDIR /workspaces/glasshouse

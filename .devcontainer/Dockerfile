FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache bash git make python3 py3-pip nodejs icu-data-full

RUN node -e 'const assert = require("node:assert/strict"); \
    const [major, minor, patch] = process.versions.node.split(".").map(Number); \
    const supported = (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) \
        || (major === 24 && minor >= 15) || major >= 26; \
    assert(!process.versions.bun && supported); \
    assert.equal(Intl.DateTimeFormat.supportedLocalesOf(["en", "fr", "ja"]).length, 3); \
    new EventTarget().addEventListener("test", () => {});'

USER bun
WORKDIR /workspaces/glasshouse

#!/usr/bin/env bash
# Exercise a separate production install built without a bundled runtime source tree.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
install="$scratch/native"
mkdir "$install"
cd "$root"
node --input-type=module -e 'const {skipReason}=await import("./packages/etl/check/pg-source.mjs"); if(skipReason) throw Error(skipReason)'
"${CUTTLELY_RECOVERY_PYTHON:-python3}" -I -c 'import pg8000.native, sqlite3; from cryptography.hazmat.primitives.ciphers.aead import AESGCM; assert hasattr(sqlite3.Connection, "serialize")'
# Read the tracked working tree, including edits under test. Private data, old build outputs, and the entire vendor are absent.
git ls-files -z -- . ':!hermes' | tar --null -T - -cf - | tar -xf - -C "$install"
test ! -e "$install/hermes"
test -s "$install/packages/etl/runtime-recovery/cuttlely_session_store.py"
printf '%s\n' '{"engine":"native"}' > "$install/packages/harness/native-distribution.json"
export HUSKY=0 CI=true PUPPETEER_SKIP_DOWNLOAD=true CYPRESS_INSTALL_BINARY=0
(
    cd "$install"
    pnpm install --frozen-lockfile
    pnpm build:docker
    rm -rf node_modules packages/*/node_modules
    pnpm install --frozen-lockfile --prod --offline --ignore-scripts
    pnpm -r rebuild sqlite3 faiss-node
    node scripts/check-sqlite-driver.mjs
    node scripts/check-static-ui-image.mjs
)
export CUTTLELY_TEST_NATIVE_PACKAGE="$install"
node --test --test-concurrency=1 scripts/kraken-ops.test.mjs scripts/kraken-upgrade.test.mjs scripts/kraken-local-research-prediction.test.mjs packages/harness/test/pinned/native-analyst.test.mjs

#!/usr/bin/env bash
# Print the git facts the handoff refresh compares against. No secrets.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git fetch --prune origin

echo "branch $(git branch --show-current)"
echo "HEAD $(git log -1 --format='%h %cs %s')"
echo "origin/main $(git log -1 --format='%h %cs %s' origin/main)"
echo "ahead-of-origin/main $(git rev-list --count origin/main..HEAD)"
echo "behind-origin/main $(git rev-list --count HEAD..origin/main)"

echo "open-prs"
if prs="$(gh pr list --state open --json number,title,headRefName --jq '.[] | "#\(.number) \(.headRefName) \(.title)"')"; then
    if [[ -n "$prs" ]]; then
        printf '%s\n' "$prs"
    else
        echo "(none)"
    fi
else
    echo "(gh pr list failed)"
fi

echo "dirty"
git status --porcelain

echo "cuttlely-branches"
git for-each-ref --format='%(refname:short)' refs/remotes/origin \
    | { grep -E '^origin/(cursor/|cuttlely-|chore/project-handoff|fix/readme-node)' || true; } \
    | while read -r ref; do
        echo "$ref ahead=$(git rev-list --count origin/main.."$ref") $(git log -1 --format='%cs %s' "$ref")"
    done

echo "recent-ci"
if ! gh run list --branch main --limit 4 --json name,conclusion,headSha,displayTitle --jq '.[] | "\(.conclusion // "pending") \(.headSha[0:9]) \(.name) \(.displayTitle)"'; then
    echo "(gh run list failed)"
fi

echo "recent-main"
git log -15 --format='%h %cs %s' origin/main

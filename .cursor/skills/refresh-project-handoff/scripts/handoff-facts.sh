#!/usr/bin/env bash
# Print the git facts the handoff refresh compares against. No secrets.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git fetch --prune origin
# The integration branch is set once, in scripts/handoff-paths.mjs.
base="$(node scripts/handoff-paths.mjs --print-branch)"

echo "branch $(git branch --show-current)"
echo "HEAD $(git log -1 --format='%h %cs %s')"
echo "origin/$base $(git log -1 --format='%h %cs %s' "origin/$base")"
echo "ahead-of-origin/$base $(git rev-list --count "origin/$base..HEAD")"
echo "behind-origin/$base $(git rev-list --count "HEAD..origin/$base")"

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

echo "open-issues"
if issues="$(gh issue list --state open --limit 50 --json number,title --jq '.[] | "#\(.number) \(.title)"')"; then
    if [[ -n "$issues" ]]; then
        printf '%s\n' "$issues"
    else
        echo "(none)"
    fi
else
    echo "(gh issue list failed)"
fi

echo "remote-branches-ahead-of-$base"
git for-each-ref --format='%(refname:short)' refs/remotes/origin \
    | { grep -Ev "^origin(/HEAD|/$base)?\$" || true; } \
    | while read -r ref; do
        ahead="$(git rev-list --count "origin/$base..$ref")"
        [[ "$ahead" == "0" ]] && continue
        echo "$ref ahead=$ahead $(git log -1 --format='%cs %s' "$ref")"
    done

echo "recent-ci"
if ! gh run list --branch "$base" --limit 4 --json name,conclusion,headSha,displayTitle --jq '.[] | "\(.conclusion // "pending") \(.headSha[0:9]) \(.name) \(.displayTitle)"'; then
    echo "(gh run list failed)"
fi

echo "recent-$base"
git log -15 --format='%h %cs %s' "origin/$base"

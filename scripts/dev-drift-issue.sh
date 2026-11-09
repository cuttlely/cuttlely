#!/usr/bin/env bash
# Keep one open issue in step with how many commits dev is missing from main.
# Drift: create the tracking issue, or update the open one. No drift: comment on and close it.
# It never opens a pull request; a person syncs main into dev with a merge commit.
# Run from a checkout that has both refs: GITHUB_REPOSITORY=owner/name bash scripts/dev-drift-issue.sh
set -euo pipefail

repo="${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to owner/name}"
base="${DRIFT_BASE_REF:-origin/dev}"
head="${DRIFT_HEAD_REF:-origin/main}"
author="${DRIFT_ISSUE_AUTHOR:-github-actions[bot]}"
marker='<!-- dev-drift-tracker -->'
max_listed=50

count="$(git rev-list --count "$base..$head")"
echo "dev-drift: $base..$head = $count"

# Open issues only, read straight from the issues API (no search index lag). Pull requests are
# skipped. The tracking issue is the oldest open one this workflow wrote that carries the marker.
issue="$(
    gh api --paginate "repos/$repo/issues?state=open&per_page=100" \
        --jq ".[] | select(.pull_request == null and .user.login == \"$author\" and ((.body // \"\") | contains(\"$marker\"))) | .number" |
        sort -n | awk 'NR == 1'
)"
echo "dev-drift: open tracking issue: ${issue:-none}"

if [[ "$count" == "0" ]]; then
    if [[ -n "$issue" ]]; then
        gh issue comment "$issue" --repo "$repo" --body "dev is up to date with main. Closing."
        gh issue close "$issue" --repo "$repo"
        echo "dev-drift: closed #$issue"
    else
        echo "dev-drift: no drift and no open issue; nothing to do"
    fi
    exit 0
fi

noun=commits
[[ "$count" == "1" ]] && noun=commit
title="dev is $count $noun behind main"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
    echo "$marker"
    echo "\`dev\` is missing $count $noun from \`main\`."
    echo
    echo "Compare: https://github.com/$repo/compare/dev...main"
    echo
    echo "Missing commits:"
    echo
    git log --format='- %h %s' -n "$max_listed" "$base..$head"
    if ((count > max_listed)); then
        echo "- and $((count - max_listed)) more"
    fi
    echo
    echo "To fix: open a pull request from \`main\` into \`dev\` and merge it with a merge commit. Never squash or rebase it."
    echo "This issue is updated by the dev drift workflow and closes when \`dev\` has everything on \`main\`."
} >"$body"

if [[ -n "$issue" ]]; then
    gh issue edit "$issue" --repo "$repo" --title "$title" --body-file "$body"
    echo "dev-drift: updated #$issue"
else
    gh issue create --repo "$repo" --title "$title" --body-file "$body"
    echo "dev-drift: created the tracking issue"
fi

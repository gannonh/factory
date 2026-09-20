#!/usr/bin/env bash
# Posts a run's evidence to a pull request as one comment.
#
# GitHub has no API for comment attachments, so the files go to the
# verification-evidence branch and the comment points at commit-pinned URLs.
# That branch shares no history with main and triggers no workflow. Nothing is
# added to the working tree, the current branch, or the PR diff.
#
# Running it again for the same run updates the same comment.
set -euo pipefail

if [[ $# -ne 2 || ! -f "$1" || ! "$2" =~ ^[0-9]+$ ]]; then
  echo "usage: post-evidence.sh STATE_FILE PR_NUMBER" >&2
  exit 2
fi
. "$1"
pr="$2"
branch="verification-evidence"
max_gif_bytes=$((10 * 1024 * 1024))

cd "$FACTORY_EVIDENCE_DIR"
shopt -s nullglob
videos=(*.webm)
screenshots=(*.png)
transcripts=()
for file in *.json *.txt; do
  # posted.txt and cleanup.txt describe the run's bookkeeping, not the proof
  [[ "$file" == posted.txt || "$file" == cleanup.txt ]] || transcripts+=("$file")
done
if [[ ${#videos[@]} -eq 0 || ${#screenshots[@]} -eq 0 ]]; then
  echo "evidence needs at least one .webm recording and one .png screenshot in $FACTORY_EVIDENCE_DIR" >&2
  exit 1
fi

for video in "${videos[@]}"; do
  base="${video%.webm}"
  ffmpeg -nostdin -loglevel error -y -i "$video" \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$base.mp4"
  ffmpeg -nostdin -loglevel error -y -i "$video" \
    -vf "fps=8,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" \
    "$base.gif"
  gif_bytes="$(stat -f %z "$base.gif")"
  if (( gif_bytes > max_gif_bytes )); then
    echo "$base.gif is $gif_bytes bytes; GitHub will not render it inline. Record a shorter proof." >&2
    exit 1
  fi
done

# glob order puts X-after.png ahead of X-before.png; show each pair in time order
ordered=()
for shot in "${screenshots[@]}"; do
  [[ "$shot" == *-after.png && -f "${shot%-after.png}-before.png" ]] && continue
  ordered+=("$shot")
  if [[ "$shot" == *-before.png && -f "${shot%-before.png}-after.png" ]]; then
    ordered+=("${shot%-before.png}-after.png")
  fi
done

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
pr_head="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)"
dest="pr-$pr/$FACTORY_RUN_ID"

parent="$(git ls-remote origin "refs/heads/$branch" | cut -f1)"
index_file="$(mktemp -u "${TMPDIR:-/tmp}/verify-factory-index.XXXXXX")"
trap 'rm -f "$index_file"' EXIT
export GIT_INDEX_FILE="$index_file"
if [[ -n "$parent" ]]; then
  git fetch --quiet origin "$branch"
  git read-tree "$parent"
else
  git read-tree --empty
fi
for file in "${screenshots[@]}" "${videos[@]/%.webm/.gif}" "${videos[@]/%.webm/.mp4}"; do
  blob="$(git hash-object -w "$file")"
  git update-index --add --cacheinfo "100644,$blob,$dest/$file"
done
tree="$(git write-tree)"
unset GIT_INDEX_FILE
if [[ -n "$parent" && "$(git rev-parse "$parent^{tree}")" == "$tree" ]]; then
  # a repeat post of unchanged files reuses the commit that already holds them
  commit="$parent"
else
  commit="$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Evidence for PR #$pr, run $FACTORY_RUN_ID")"
  git push --quiet origin "$commit:refs/heads/$branch"
fi

raw="https://raw.githubusercontent.com/$repo/$commit/$dest"
blob_page="https://github.com/$repo/blob/$commit/$dest"
marker="<!-- verify-factory:$FACTORY_RUN_ID -->"
body_file="$FACTORY_EVIDENCE_DIR/comment.md"
{
  printf '%s\n' "$marker"
  printf '### Factory verification evidence\n\n'
  printf 'Run `%s` drove the live web UI at commit `%s`.' "$FACTORY_RUN_ID" "$FACTORY_HEAD_SHA"
  if [[ "$pr_head" != "$FACTORY_HEAD_SHA" ]]; then
    printf ' The PR head was `%s` when this was posted.' "$pr_head"
  fi
  printf '\n\n'
  for video in "${videos[@]}"; do
    base="${video%.webm}"
    printf '#### Recording: %s\n\n' "$base"
    printf '![%s](%s/%s.gif)\n\n' "$base" "$raw" "$base"
    printf '[Full-quality MP4](%s/%s.mp4)\n\n' "$blob_page" "$base"
  done
  printf '#### Screenshots\n\n'
  for shot in "${ordered[@]}"; do
    printf '**%s**\n\n![%s](%s/%s)\n\n' "$shot" "$shot" "$raw" "$shot"
  done
  if [[ ${#transcripts[@]} -gt 0 ]]; then
    printf '<details><summary>Transcripts</summary>\n\n'
    for transcript in "${transcripts[@]}"; do
      printf '**%s**\n\n```\n' "$transcript"
      head -c 4000 "$transcript"
      printf '\n```\n\n'
    done
    printf '</details>\n'
  fi
} > "$body_file"

comment_id="$(gh api "repos/$repo/issues/$pr/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n 1)"
if [[ -n "$comment_id" ]]; then
  comment_url="$(gh api --method PATCH "repos/$repo/issues/comments/$comment_id" -F "body=@$body_file" --jq .html_url)"
else
  comment_url="$(gh api --method POST "repos/$repo/issues/$pr/comments" -F "body=@$body_file" --jq .html_url)"
fi

{
  printf 'comment=%s\n' "$comment_url"
  printf 'evidence_commit=%s\n' "$commit"
  printf 'evidence_path=%s\n' "$dest"
} | tee "$FACTORY_EVIDENCE_DIR/posted.txt"

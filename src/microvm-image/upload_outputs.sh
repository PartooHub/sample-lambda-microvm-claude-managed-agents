#!/bin/bash
# Upload the session outputs to S3 and print a one-hour presigned link per file.
# The links are printed for the final answer only; never write them to a file or a log.
# Usage: upload_outputs [session-id]
# The session id comes from the argument, then ANTHROPIC_SESSION_ID, then the file the worker
# writes when it serves a work item (/var/run/served_session).
set -euo pipefail

OUTPUTS_DIR=/mnt/session/outputs
SERVED_SESSION_FILE=/var/run/served_session
BUCKET="${ARTIFACTS_BUCKET:-claude-microvm-sandbox-artifacts-575108925548-eu-west-1}"
REGION="${AWS_REGION:-eu-west-1}"
EXPIRES_SECONDS=3600

SESSION_ID="${1:-${ANTHROPIC_SESSION_ID:-}}"
if [ -z "$SESSION_ID" ] && [ -f "$SERVED_SESSION_FILE" ]; then
  SESSION_ID="$(cat "$SERVED_SESSION_FILE")"
fi

# Session ids become part of the S3 key, so accept only the expected shape.
if ! [[ "$SESSION_ID" =~ ^sesn_[A-Za-z0-9_-]+$ ]]; then
  echo "upload_outputs: no valid session id (got '${SESSION_ID}')" >&2
  exit 1
fi

if [ ! -d "$OUTPUTS_DIR" ]; then
  echo "upload_outputs: $OUTPUTS_DIR does not exist" >&2
  exit 1
fi

PREFIX="outputs/$SESSION_ID"
aws s3 cp "$OUTPUTS_DIR" "s3://$BUCKET/$PREFIX/" --recursive --only-show-errors --region "$REGION"

echo "Uploaded to s3://$BUCKET/$PREFIX/. Links below expire in $((EXPIRES_SECONDS / 60)) minutes."
cd "$OUTPUTS_DIR"
# File names with spaces are not supported: name screenshots by step, without spaces.
find . -type f | sed 's|^\./||' | sort | while IFS= read -r rel; do
  url="$(aws s3 presign "s3://$BUCKET/$PREFIX/$rel" --expires-in "$EXPIRES_SECONDS" --region "$REGION")"
  echo "$rel"
  echo "$url"
  echo
done

#!/bin/sh
# Creates the transcript bucket and a kd-api user limited to it. Safe to rerun on every `up`.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing local/kd-transcripts

# kd-api needs HeadBucket (ListBucket) for /healthz, and put/get/delete on transcript objects.
cat >/tmp/kd-api-transcripts.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::kd-transcripts"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::kd-transcripts/*"]
    }
  ]
}
JSON
mc admin policy create local kd-api-transcripts /tmp/kd-api-transcripts.json >/dev/null
mc admin user add local "$KD_S3_ACCESS_KEY" "$KD_S3_SECRET_KEY" >/dev/null
if ! mc admin user info local "$KD_S3_ACCESS_KEY" --json | grep -q '"policyName": *"kd-api-transcripts"'; then
  mc admin policy attach local kd-api-transcripts --user "$KD_S3_ACCESS_KEY" >/dev/null
fi
echo "bucket kd-transcripts and user $KD_S3_ACCESS_KEY ready"

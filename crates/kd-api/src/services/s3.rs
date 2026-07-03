// put_transcript, get_transcript, s3_uri

use aws_sdk_s3 as s3;

pub async fn put_transcript(
    client: &s3::Client,
    bucket: &str,
    key: &str,
    bytes: Vec<u8>,
) -> Result<(), s3::error::SdkError<s3::operation::put_object::PutObjectError>> {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(bytes.into())
        .send()
        .await
        .map(|_| ())
}

pub async fn get_transcript(
    client: &s3::Client,
    bucket: &str,
    key: &str,
) -> anyhow::Result<Vec<u8>> {
    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("S3 GetObject failed: {e}"))?;
    let bytes = resp
        .body
        .collect()
        .await
        .map_err(|e| anyhow::anyhow!("S3 body read failed: {e}"))?;
    Ok(bytes.into_bytes().to_vec())
}

/// Best-effort removal of a transcript object. Used to clean up an S3 upload
/// whose durable DB row was never written (ON CONFLICT loser, or a DB failure
/// after the upload), so the object does not linger with nothing referencing it.
pub async fn delete_transcript(
    client: &s3::Client,
    bucket: &str,
    key: &str,
) -> Result<(), s3::error::SdkError<s3::operation::delete_object::DeleteObjectError>> {
    client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map(|_| ())
}

pub fn s3_uri(bucket: &str, key: &str) -> String {
    format!("s3://{}/{}", bucket, key)
}

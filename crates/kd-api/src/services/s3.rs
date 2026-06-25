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

pub fn s3_uri(bucket: &str, key: &str) -> String {
    format!("s3://{}/{}", bucket, key)
}

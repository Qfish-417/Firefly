import assert from "node:assert/strict";
import test from "node:test";

import { CreateBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { AwsS3ObjectDeletionPort } from "../src/index.ts";

const endpoint = process.env.TEST_S3_ENDPOINT;

test(
  "AWS S3 adapter deletes a real S3-compatible object",
  { skip: endpoint ? false : "TEST_S3_ENDPOINT is not configured" },
  async () => {
    assert.ok(endpoint);
    const config = {
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "minioadmin",
        secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "minioadmin",
      },
    } as const;
    const client = new S3Client(config);
    const deletion = new AwsS3ObjectDeletionPort(config);
    const bucket = "firefly-worker-integration";
    const key = "memories/delete-me.json";
    try {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isBucketExists(error)) throw error;
      }
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "delete me" }));
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await deletion.deleteObject({ bucket, key });
      await assert.rejects(client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
    } finally {
      deletion.destroy();
      client.destroy();
    }
  },
);

function isBucketExists(error: unknown): boolean {
  return error instanceof Error && ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.name);
}

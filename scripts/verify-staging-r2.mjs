import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

async function runR2Verification() {
  const accessKeyId =
    process.env.R2_STAGING_ACCESS_KEY_ID ||
    process.env.R2_ACCESS_KEY_ID_STAGING ||
    process.env.R2_ACCESS_KEY_ID;

  const secretAccessKey =
    process.env.R2_STAGING_SECRET_ACCESS_KEY ||
    process.env.R2_SECRET_ACCESS_KEY_STAGING ||
    process.env.R2_SECRET_ACCESS_KEY;

  const endpoint =
    process.env.R2_ENDPOINT ||
    "https://81fafb4f3e16f76292b4458bdab4f180.r2.cloudflarestorage.com";

  if (!accessKeyId || !secretAccessKey) {
    console.error("[ERROR] Missing staging R2 credentials.");
    console.error("Please supply R2_STAGING_ACCESS_KEY_ID and R2_STAGING_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  console.log("=== CellWeave Phase 0 STAGING R2 Runtime Access Verification ===\n");
  console.log(`Endpoint:    ${endpoint}`);
  console.log(`Key ID:      [PRESENT, length=${accessKeyId.length}]`);

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true,
  });

  const stagingBucket = "cellweave-artifacts-staging";
  const devBucket = "cellweave-artifacts-dev";
  const stateBucket = "cellweave-terraform-state";
  const probeKey = `_probe_test_${Date.now()}.txt`;
  const probeContent = "cellweave-staging-phase0-probe";

  // 1. Positive tests on cellweave-artifacts-staging
  console.log(`\n[1/3] Testing positive operations on target staging bucket: '${stagingBucket}'...`);

  // List
  const listRes = await s3.send(new ListObjectsV2Command({ Bucket: stagingBucket }));
  console.log("  -> ListObjectsV2: SUCCESS (current objects:", listRes.Contents?.length || 0, ")");

  // Put
  await s3.send(
    new PutObjectCommand({
      Bucket: stagingBucket,
      Key: probeKey,
      Body: probeContent,
      ContentType: "text/plain",
    })
  );
  console.log(`  -> PutObject: SUCCESS (uploaded '${probeKey}')`);

  // Get
  const getRes = await s3.send(new GetObjectCommand({ Bucket: stagingBucket, Key: probeKey }));
  const retrieved = await getRes.Body.transformToString();
  console.log("  -> GetObject: SUCCESS (content match:", retrieved === probeContent, ")");

  // Delete
  await s3.send(new DeleteObjectCommand({ Bucket: stagingBucket, Key: probeKey }));
  console.log(`  -> DeleteObject: SUCCESS (removed '${probeKey}')`);

  // Confirm cleanup
  const postList = await s3.send(new ListObjectsV2Command({ Bucket: stagingBucket, Prefix: probeKey }));
  const cleaned = !postList.Contents || postList.Contents.length === 0;
  console.log("  -> Cleanup confirmed:", cleaned);

  // 2. Negative isolation test on cellweave-terraform-state
  console.log(`\n[2/3] Negative Isolation Probe: Attempting access to '${stateBucket}'...`);
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: stateBucket }));
    throw new Error(`SECURITY VIOLATION: Staging R2 credentials were able to access ${stateBucket}!`);
  } catch (err) {
    if (err.message.includes("SECURITY VIOLATION")) throw err;
    console.log(`  -> Correctly DENIED: ${err.name || "Error"} (${err.message.split("\n")[0]})`);
  }

  // 3. Negative isolation test on cellweave-artifacts-dev
  console.log(`\n[3/3] Negative Isolation Probe: Attempting access to '${devBucket}'...`);
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: devBucket }));
    throw new Error(`SECURITY VIOLATION: Staging R2 credentials were able to access ${devBucket}!`);
  } catch (err) {
    if (err.message.includes("SECURITY VIOLATION")) throw err;
    console.log(`  -> Correctly DENIED: ${err.name || "Error"} (${err.message.split("\n")[0]})`);
  }

  console.log("\n============================================================");
  console.log("STAGING R2 RUNTIME ACCESS VERIFICATION: PASSED");
  console.log("============================================================");
}

runR2Verification().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});

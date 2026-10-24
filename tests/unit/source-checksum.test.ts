import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  computeTrustedSourceChecksum,
  type TrustedSourceFileFact,
} from "@/server/services/source-checksum";

const facts: TrustedSourceFileFact[] = [
  {
    datasetFileId: "f1",
    fileName: "A.tsv",
    byteSize: 0,
    sha256: "a".repeat(64),
    role: "MATRIX",
    ordinal: 0,
  },
  {
    datasetFileId: "f2",
    fileName: "a.tsv",
    byteSize: 7,
    sha256: "b".repeat(64),
    role: "CELL_METADATA",
    ordinal: 0,
  },
  {
    datasetFileId: "f3",
    fileName: "ß.tsv",
    byteSize: 1234,
    sha256: "c".repeat(64),
    role: "FEATURE_METADATA",
    ordinal: 0,
  },
];
// Precomputed independently with approved science compute_source_checksum(), not this helper.
const fixedDigest = "785e0ab60577cd6ff6240d3c50b87530973c1ec153d99d63dfe13e74e1c25e02";
const fixedManifest =
  "A.tsv\t0\t" +
  "a".repeat(64) +
  "\na.tsv\t7\t" +
  "b".repeat(64) +
  "\nß.tsv\t1234\t" +
  "c".repeat(64) +
  "\n";

describe("format-specific trusted source checksums", () => {
  it.each(["H5AD", "TENX_H5"] as const)(
    "returns the exact physical SHA for %s without manifest wrapping",
    (sourceFormat) => {
      const file: TrustedSourceFileFact = { ...facts[0]!, role: "PRIMARY" };
      const result = computeTrustedSourceChecksum({ sourceFormat, files: [file] });
      expect(result).toEqual({ sourceChecksum: file.sha256, manifest: null });
      const wrapped = createHash("sha256")
        .update(`A.tsv\t0\t${file.sha256}\n`, "utf8")
        .digest("hex");
      expect(result.sourceChecksum).not.toBe(wrapped);
    }
  );

  it("matches exact case-sensitive UTF-8/TAB/LF bytes and a science-generated constant", () => {
    const result = computeTrustedSourceChecksum({
      sourceFormat: "GENERIC_MATRIX",
      files: [facts[2]!, facts[1]!, facts[0]!],
    });
    expect(result.manifest).toBe(fixedManifest);
    expect(Buffer.from(result.manifest ?? "")).toEqual(Buffer.from(fixedManifest, "utf8"));
    expect(result.manifest).not.toContain("\r");
    expect(result.sourceChecksum).toBe(fixedDigest);
    expect(facts.map((file) => file.fileName)).toEqual(["A.tsv", "a.tsv", "ß.tsv"]);
  });

  it("hashes a one-file Generic manifest, including spaces, rather than returning its physical SHA", () => {
    const file: TrustedSourceFileFact = {
      datasetFileId: "single",
      fileName: "sample 01.tsv",
      byteSize: 42,
      sha256: "0".repeat(64),
      role: "MATRIX",
      ordinal: 0,
    };
    expect(computeTrustedSourceChecksum({ sourceFormat: "GENERIC_MATRIX", files: [file] })).toEqual(
      {
        manifest: `sample 01.tsv\t42\t${"0".repeat(64)}\n`,
        sourceChecksum: "3b31b99468b5cd88de2d8c62af677ef5b2603c1397ba83538b3d150424acb021",
      }
    );
  });

  it("matches the approved science TENX_MTX test fixture", () => {
    const files: TrustedSourceFileFact[] = [
      {
        datasetFileId: "m",
        fileName: "matrix.mtx.gz",
        byteSize: 1024,
        sha256: "3".repeat(64),
        role: "MATRIX",
        ordinal: 0,
      },
      {
        datasetFileId: "b",
        fileName: "barcodes.tsv.gz",
        byteSize: 256,
        sha256: "1".repeat(64),
        role: "BARCODES",
        ordinal: 1,
      },
      {
        datasetFileId: "f",
        fileName: "features.tsv.gz",
        byteSize: 512,
        sha256: "2".repeat(64),
        role: "FEATURES",
        ordinal: 2,
      },
    ];
    expect(computeTrustedSourceChecksum({ sourceFormat: "TENX_MTX", files })).toEqual({
      manifest: `barcodes.tsv.gz\t256\t${"1".repeat(64)}\nfeatures.tsv.gz\t512\t${"2".repeat(64)}\nmatrix.mtx.gz\t1024\t${"3".repeat(64)}\n`,
      sourceChecksum: "69a76db537290feab98f01ef5bbefb3662aeed1d8376ea468079017c72e63e92",
    });
  });

  it("is independent of input order", () => {
    for (const files of [facts, [...facts].reverse(), [facts[1]!, facts[2]!, facts[0]!]]) {
      expect(
        computeTrustedSourceChecksum({ sourceFormat: "GENERIC_MATRIX", files }).sourceChecksum
      ).toBe(fixedDigest);
    }
  });

  it.each([
    { byteSize: 1 },
    { sha256: "d".repeat(64) },
    { fileName: "B.tsv" },
    { fileName: "A.TSV" },
  ])("changes when a persisted fact changes: %j", (change) => {
    expect(
      computeTrustedSourceChecksum({
        sourceFormat: "GENERIC_MATRIX",
        files: [{ ...facts[0]!, ...change }, ...facts.slice(1)],
      }).sourceChecksum
    ).not.toBe(fixedDigest);
  });

  it("does not serialize role, ordinal, or file IDs", () => {
    const files = facts.map((file, index) => ({
      ...file,
      datasetFileId: `other-${index}`,
      ordinal: 123,
    }));
    expect(
      computeTrustedSourceChecksum({ sourceFormat: "GENERIC_MATRIX", files }).sourceChecksum
    ).toBe(fixedDigest);
  });

  it("sorts supplementary Unicode consistently with Python code-point order", () => {
    const result = computeTrustedSourceChecksum({
      sourceFormat: "GENERIC_MATRIX",
      files: [
        { ...facts[0]!, fileName: "\u{10000}.tsv" },
        { ...facts[1]!, fileName: "\ue000.tsv" },
      ],
    });
    expect(result.manifest?.startsWith("\ue000.tsv\t")).toBe(true);
  });

  it("rejects duplicate exact filenames without collapsing or tie breaking", () => {
    expect(() =>
      computeTrustedSourceChecksum({
        sourceFormat: "GENERIC_MATRIX",
        files: [facts[0]!, { ...facts[1]!, fileName: "A.tsv" }],
      })
    ).toThrow(/Duplicate persisted/);
  });

  it.each([
    { fileName: "" },
    { fileName: " " },
    { fileName: " A.tsv" },
    { fileName: "dir/A.tsv" },
    { fileName: "../A.tsv" },
    { fileName: "a\tb.tsv" },
    { fileName: "a\nb.tsv" },
    { fileName: "a\rb.tsv" },
    { fileName: "a\0b.tsv" },
    { fileName: "a".repeat(256) },
    { fileName: "\ud800.tsv" },
    { byteSize: -1 },
    { byteSize: 1.5 },
    { byteSize: NaN },
    { byteSize: Infinity },
    { byteSize: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: "A".repeat(64) },
    { sha256: "a".repeat(63) },
    { sha256: "a".repeat(65) },
    { sha256: "g".repeat(64) },
    { sha256: "a".repeat(64) + "\n" },
  ])("rejects invalid persisted facts: %j", (change) => {
    expect(() =>
      computeTrustedSourceChecksum({
        sourceFormat: "GENERIC_MATRIX",
        files: [{ ...facts[0]!, ...change }],
      })
    ).toThrow();
  });

  it.each(["H5AD", "TENX_H5", "TENX_MTX"] as const)(
    "enforces %s cardinality and roles",
    (sourceFormat) => {
      expect(() => computeTrustedSourceChecksum({ sourceFormat, files: [facts[0]!] })).toThrow();
    }
  );

  it("rejects unsupported source format without inference", () => {
    expect(() =>
      Reflect.apply(computeTrustedSourceChecksum, undefined, [
        { sourceFormat: "CSV", files: facts },
      ])
    ).toThrow(/Unsupported/);
  });
});

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { assertContract, type IndexEvaluationSet } from "@firefly/contracts";

import { indexEvaluationSetDigest } from "./index-quality-probes.ts";

export async function loadIndexEvaluationSetFile(path: string, maxBytes = 5_000_000): Promise<IndexEvaluationSet> {
  if (!isAbsolute(path)) throw new TypeError("Index evaluation set path must be absolute");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 50_000_000) {
    throw new TypeError("Index evaluation set byte limit must be between 1024 and 50000000");
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new TypeError("Index evaluation set file is empty, oversized or not a regular file");
  }
  return parseIndexEvaluationSetJson(await readFile(path), maxBytes);
}

export function parseIndexEvaluationSetJson(bytes: Uint8Array, maxBytes = 5_000_000): IndexEvaluationSet {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new TypeError("Index evaluation set exceeds the byte limit");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("Index evaluation set must be valid UTF-8 JSON"); }
  try { assertContract("IndexEvaluationSet", value); }
  catch { throw new TypeError("Index evaluation set does not satisfy the v1 contract"); }
  const evaluationSet = value as IndexEvaluationSet;
  if (evaluationSet.artifact_ref.digest !== indexEvaluationSetDigest(evaluationSet)) {
    throw new TypeError("Index evaluation set Artifact digest does not match its canonical payload");
  }
  return evaluationSet;
}

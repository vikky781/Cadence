import type { Asset } from "../dsl/types"

export interface AssetLoadResult {
  assetId: string
  ok: boolean
  bytes?: ArrayBuffer
  imageBitmap?: ImageBitmap
  audioBuffer?: AudioBuffer
  error?: string
}

export class AssetPreloadError extends Error {
  failures: AssetLoadResult[]

  constructor(failures: AssetLoadResult[]) {
    super(`Failed to preload ${failures.length} asset(s).`)
    this.name = "AssetPreloadError"
    this.failures = failures
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function loadOneAsset(asset: Asset, audioContext?: AudioContext): Promise<AssetLoadResult> {
  let bytes: ArrayBuffer
  try {
    const response = await fetch(asset.storagePath)
    if (!response.ok) {
      return { assetId: asset.id, ok: false, error: `fetch failed with status ${response.status}` }
    }
    bytes = await response.arrayBuffer()
  } catch (error) {
    return {
      assetId: asset.id,
      ok: false,
      error: `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let hashHex: string
  try {
    hashHex = await sha256Hex(bytes)
  } catch (error) {
    return {
      assetId: asset.id,
      ok: false,
      error: `hashing failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (hashHex !== asset.sha256.toLowerCase()) {
    return { assetId: asset.id, ok: false, error: "hash mismatch" }
  }

  if (asset.kind === "image") {
    try {
      const imageBitmap = await createImageBitmap(new Blob([bytes]))
      return { assetId: asset.id, ok: true, bytes, imageBitmap }
    } catch (error) {
      return {
        assetId: asset.id,
        ok: false,
        error: `image decode failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  if (asset.kind === "audio") {
    if (!audioContext) {
      return { assetId: asset.id, ok: true, bytes }
    }
    try {
      // Pass a copy: decodeAudioData takes ownership of (and typically
      // detaches) the buffer it's given, and we still want to return the
      // original bytes in the result.
      const audioBuffer = await audioContext.decodeAudioData(bytes.slice(0))
      return { assetId: asset.id, ok: true, bytes, audioBuffer }
    } catch (error) {
      return {
        assetId: asset.id,
        ok: false,
        error: `audio decode failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // kind === "video": fetch and hash-check only, no decoding attempted.
  return { assetId: asset.id, ok: true, bytes }
}

export async function preloadAssets(
  assets: Asset[],
  audioContext?: AudioContext,
): Promise<AssetLoadResult[]> {
  const results = await Promise.all(assets.map((asset) => loadOneAsset(asset, audioContext)))

  const failures = results.filter((result) => !result.ok)
  if (failures.length > 0) {
    throw new AssetPreloadError(failures)
  }

  return results
}

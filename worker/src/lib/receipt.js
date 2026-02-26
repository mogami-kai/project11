import { buildError } from '../http/response.js';

const RECEIPT_MAX_EDGE_PX = 1200;
const RECEIPT_JPEG_QUALITY = 0.7;
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

function stripDataUrlPrefix(imageBase64) {
  const raw = String(imageBase64 || '').trim();
  if (!raw) return { base64: '', mimeType: '' };
  const m = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) {
    return { base64: raw, mimeType: '' };
  }
  return {
    mimeType: String(m[1] || '').trim().toLowerCase(),
    base64: String(m[2] || '').trim()
  };
}

function base64ToUint8Array(base64Text) {
  const text = String(base64Text || '').trim();
  if (!text) return new Uint8Array(0);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function normalizeInputMimeType(mimeType, fallbackMimeType) {
  const preferred = String(mimeType || '').trim().toLowerCase();
  const fallback = String(fallbackMimeType || '').trim().toLowerCase();
  const resolved = preferred || fallback;

  if (/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(resolved)) {
    return resolved;
  }

  return '';
}

async function decodeImageFrame(bytes, mimeType) {
  if (typeof ImageDecoder !== 'function') {
    throw new Error('IMAGE_DECODER_UNAVAILABLE');
  }

  const decoder = new ImageDecoder({
    data: bytes,
    type: mimeType
  });

  const decoded = await decoder.decode({ frameIndex: 0 });
  return decoded.image;
}

async function resizeToJpeg(image, options = {}) {
  const maxEdge = Number(options.maxEdgePx || RECEIPT_MAX_EDGE_PX);
  const quality = Number(options.quality || RECEIPT_JPEG_QUALITY);

  if (typeof OffscreenCanvas !== 'function') {
    throw new Error('OFFSCREEN_CANVAS_UNAVAILABLE');
  }

  const sourceWidth = Number(image?.codedWidth || image?.displayWidth || image?.width || 0);
  const sourceHeight = Number(image?.codedHeight || image?.displayHeight || image?.height || 0);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('INVALID_IMAGE_DIMENSIONS');
  }

  const longestEdge = Math.max(sourceWidth, sourceHeight);
  const scale = longestEdge > maxEdge ? (maxEdge / longestEdge) : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('CANVAS_CONTEXT_UNAVAILABLE');
  }

  ctx.drawImage(image, 0, 0, width, height);
  if (typeof image.close === 'function') {
    image.close();
  }

  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality
  });

  const arrayBuffer = await blob.arrayBuffer();
  return {
    bytes: new Uint8Array(arrayBuffer),
    width,
    height
  };
}

function toUrl(base, key) {
  const prefix = String(base || '').trim().replace(/\/+$/, '');
  const suffix = String(key || '').trim().replace(/^\/+/, '');
  return `${prefix}/${suffix}`;
}

export async function processAndStoreReceipt(env, requestId, input) {
  const imageBase64 = String(input?.imageBase64 || '').trim();
  if (!imageBase64) {
    return {
      ok: true,
      receiptUrl: null,
      resized: false,
      sizeBytes: 0
    };
  }

  const parsed = stripDataUrlPrefix(imageBase64);
  const inputMimeType = normalizeInputMimeType(input?.mimeType, parsed.mimeType);
  if (!inputMimeType) {
    return {
      ok: false,
      error: buildError(
        'E_VALIDATION',
        'Validation failed.',
        { fields: [{ field: 'receipt.image_base64', reason: 'unsupported image type' }] },
        false
      ),
      status: 400
    };
  }

  // Spec: v5_spec 2.2 Images Policy (receipt: 1200px, JPEG 70%, URL only)
  const rawBytes = base64ToUint8Array(parsed.base64);
  if (!rawBytes.length) {
    return {
      ok: false,
      error: buildError('E_VALIDATION', 'Validation failed.', { fields: [{ field: 'receipt.image_base64', reason: 'required' }] }, false),
      status: 400
    };
  }

  let resized;
  try {
    const frame = await decodeImageFrame(rawBytes, inputMimeType);
    resized = await resizeToJpeg(frame, {
      maxEdgePx: RECEIPT_MAX_EDGE_PX,
      quality: RECEIPT_JPEG_QUALITY
    });
  } catch (error) {
    return {
      ok: false,
      error: buildError(
        'E_UPSTREAM',
        'Failed to resize receipt image.',
        { reason: String(error?.message || error) },
        true
      ),
      status: 502
    };
  }

  if (resized.bytes.byteLength > RECEIPT_MAX_BYTES) {
    return {
      ok: false,
      error: buildError(
        'E_IMAGE_TOO_LARGE',
        'Receipt image exceeds 5MB after resize',
        { sizeKB: Math.ceil(resized.bytes.byteLength / 1024) },
        false
      ),
      status: 400
    };
  }

  const bucket = env.RECEIPT_BUCKET;
  const publicBaseUrl = String(env.RECEIPT_PUBLIC_BASE_URL || '').trim();
  if (!bucket || !publicBaseUrl) {
    return {
      ok: false,
      error: buildError(
        'E_CONFIG',
        'Missing receipt storage configuration.',
        {
          missing: [
            !bucket ? 'RECEIPT_BUCKET' : null,
            !publicBaseUrl ? 'RECEIPT_PUBLIC_BASE_URL' : null
          ].filter(Boolean)
        },
        false
      ),
      status: 500
    };
  }

  const expenseId = String(input?.expenseId || '').trim();
  const fileKey = `receipts/${expenseId}.jpg`;

  try {
    await bucket.put(fileKey, resized.bytes, {
      httpMetadata: {
        contentType: 'image/jpeg'
      },
      customMetadata: {
        requestId: String(requestId || '').slice(0, 120)
      }
    });
  } catch (error) {
    return {
      ok: false,
      error: buildError(
        'E_UPSTREAM',
        'Failed to store receipt image.',
        { reason: String(error?.message || error) },
        true
      ),
      status: 502
    };
  }

  return {
    ok: true,
    receiptUrl: toUrl(publicBaseUrl, fileKey),
    resized: true,
    sizeBytes: resized.bytes.byteLength
  };
}

/**
 * lib/imagePrep.js
 * Image preprocessing for OCR.
 *
 * 1. readJpegExifOrientation(bytes) — pure byte-level EXIF Orientation tag reader
 * 2. prepareImageForOcr(base64, mimeType, options) — EXIF correction + resize
 *
 * Both functions are pure/sync-compatible or gracefully fall back when
 * ImageDecoder / OffscreenCanvas are unavailable (e.g. local Node.js tests).
 * No external dependencies.
 */

const OCR_MAX_EDGE_PX = 1600;
const OCR_JPEG_QUALITY = 0.85;

/**
 * Read the EXIF Orientation tag from JPEG bytes.
 * Returns 1–8 (1 = no rotation). Returns 1 on any parse error.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function readJpegExifOrientation(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return 1;
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 1;  // not JPEG

  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xFF) break;
    const marker = bytes[pos + 1];
    // Segment length includes the 2 length bytes themselves
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];

    if (marker === 0xE1 && segLen >= 8) {         // APP1
      const dataStart = pos + 4;
      const app1End   = pos + 2 + segLen;

      // Check "Exif\0\0" identifier
      if (
        app1End <= bytes.length &&
        bytes[dataStart]     === 0x45 && bytes[dataStart + 1] === 0x78 &&  // Ex
        bytes[dataStart + 2] === 0x69 && bytes[dataStart + 3] === 0x66 &&  // if
        bytes[dataStart + 4] === 0x00 && bytes[dataStart + 5] === 0x00
      ) {
        const tiff = dataStart + 6;
        const le   = bytes[tiff] === 0x49;  // 0x49='I' → little-endian

        const r16 = (o) => le
          ? (bytes[tiff + o] | (bytes[tiff + o + 1] << 8))
          : ((bytes[tiff + o] << 8) | bytes[tiff + o + 1]);

        const r32 = (o) => le
          ? ((r16(o) | (r16(o + 2) << 16)) >>> 0)
          : (((r16(o) << 16) | r16(o + 2)) >>> 0);

        if (r16(2) !== 42) { pos += 2 + segLen; continue; }  // TIFF magic check

        const ifd0     = r32(4);
        const ifd0Abs  = tiff + ifd0;
        if (ifd0Abs + 2 > app1End) { pos += 2 + segLen; continue; }

        const count = r16(ifd0);
        for (let i = 0; i < count; i++) {
          const entry = ifd0 + 2 + i * 12;
          if (tiff + entry + 12 > app1End) break;
          if (r16(entry) === 0x0112) {           // Orientation tag
            const val = r16(entry + 8);
            return (val >= 1 && val <= 8) ? val : 1;
          }
        }
      }
    }

    if (segLen < 2) break;
    pos += 2 + segLen;
  }
  return 1;
}

/**
 * Preprocess an image for OCR:
 *   1. Parse EXIF orientation (JPEG only) and correct via canvas transform
 *   2. Resize long-edge to OCR_MAX_EDGE_PX (default 1600px)
 *   3. Re-encode as JPEG (quality 0.85)
 *
 * Falls back transparently when ImageDecoder / OffscreenCanvas unavailable.
 *
 * @param {string} imageBase64 - raw base64 (no data-URL prefix)
 * @param {string} mimeType    - e.g. 'image/jpeg'
 * @param {object} [options]
 * @param {number} [options.maxEdgePx=1600]
 * @param {number} [options.quality=0.85]
 * @returns {Promise<{ base64: string, mimeType: string, preprocessed: boolean }>}
 */
export async function prepareImageForOcr(imageBase64, mimeType, options = {}) {
  const base64 = String(imageBase64 || '').trim();
  const mime   = String(mimeType    || 'image/jpeg').trim().toLowerCase();
  const noOp   = { base64, mimeType: mime, preprocessed: false };

  if (!base64) return noOp;
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) return noOp;

  // Graceful fallback when runtime Canvas APIs are absent (e.g. local Node tests)
  if (typeof ImageDecoder !== 'function' || typeof OffscreenCanvas !== 'function') {
    return noOp;
  }

  let bytes;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return noOp;
  }

  const isJpeg   = mime === 'image/jpeg' || mime === 'image/jpg';
  const orient   = isJpeg ? readJpegExifOrientation(bytes) : 1;
  const swapDims = orient >= 5 && orient <= 8;

  let image;
  try {
    const decoder = new ImageDecoder({ data: bytes.buffer, type: mime });
    const decoded = await decoder.decode({ frameIndex: 0 });
    image = decoded.image;
  } catch {
    return noOp;
  }

  try {
    const srcW = Number(image.codedWidth  || image.displayWidth  || image.width  || 0);
    const srcH = Number(image.codedHeight || image.displayHeight || image.height || 0);
    if (!srcW || !srcH) return noOp;

    // Logical dimensions after orientation correction
    const logW = swapDims ? srcH : srcW;
    const logH = swapDims ? srcW : srcH;

    const maxEdge = Number(options.maxEdgePx || OCR_MAX_EDGE_PX);
    const scale   = Math.max(logW, logH) > maxEdge ? maxEdge / Math.max(logW, logH) : 1;

    const canvasW = Math.max(1, Math.round(logW * scale));
    const canvasH = Math.max(1, Math.round(logH * scale));
    const drawW   = Math.round(srcW * scale);
    const drawH   = Math.round(srcH * scale);

    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx    = canvas.getContext('2d', { alpha: false });
    if (!ctx) return noOp;

    // White background (handles PNG transparency)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Apply EXIF orientation correction.
    // Each case maps draw-space (0..drawW, 0..drawH) → canvas-space (0..canvasW, 0..canvasH).
    // setTransform(a, b, c, d, e, f):  cx = a*x + c*y + e,  cy = b*x + d*y + f
    switch (orient) {
      case 2: ctx.setTransform(-1,  0,  0,  1, canvasW, 0);        break; // flip X
      case 3: ctx.setTransform(-1,  0,  0, -1, canvasW, canvasH);  break; // rotate 180°
      case 4: ctx.setTransform( 1,  0,  0, -1, 0,       canvasH);  break; // flip Y
      case 5: ctx.setTransform( 0,  1,  1,  0, 0,       0);        break; // transpose
      case 6: ctx.setTransform( 0,  1, -1,  0, canvasW, 0);        break; // rotate 90° CW
      case 7: ctx.setTransform( 0, -1, -1,  0, canvasW, canvasH);  break; // transverse
      case 8: ctx.setTransform( 0, -1,  1,  0, 0,       canvasH);  break; // rotate 90° CCW
      // case 1: identity — no setTransform needed
    }

    ctx.drawImage(image, 0, 0, drawW, drawH);

    const quality = Number(options.quality || OCR_JPEG_QUALITY);
    const blob    = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const buf     = await blob.arrayBuffer();
    const out     = new Uint8Array(buf);

    let outB64 = '';
    for (let i = 0; i < out.length; i++) outB64 += String.fromCharCode(out[i]);

    return { base64: btoa(outB64), mimeType: 'image/jpeg', preprocessed: true };
  } finally {
    if (image && typeof image.close === 'function') image.close();
  }
}

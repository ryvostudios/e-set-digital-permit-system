import sharp from 'sharp';

export type ImagePurpose = 'PDF_LOGO' | 'WEB_LOGO' | 'PWA_ICON';
export interface ValidatedImage { bytes: Buffer; mimeType: 'image/png'; width: number; height: number }

/** Decode untrusted raster bytes, then encode a small canonical PNG. */
export async function validateBrandImage(input: Buffer, declaredMime: string,
  purpose: ImagePurpose): Promise<ValidatedImage> {
  if (!Buffer.isBuffer(input) || input.length < 16 || input.length > 2 * 1024 * 1024 ||
      !['image/png', 'image/jpeg'].includes(declaredMime)) throw new Error('Invalid image');
  try {
    const source = sharp(input, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const info = await source.metadata();
    if (!info.width || !info.height || info.width < 32 || info.height < 32 ||
        info.width > 4096 || info.height > 4096 ||
        (info.format === 'png' ? 'image/png' : info.format === 'jpeg' ? 'image/jpeg' : '') !== declaredMime) {
      throw new Error('Invalid image dimensions or format');
    }
    if (purpose === 'PWA_ICON' && (info.width !== info.height || info.width < 512)) {
      throw new Error('Application icon must be square and at least 512 pixels');
    }
    const dimension = purpose === 'PWA_ICON' ? 512 : 1024;
    let pipeline = source.rotate()
      .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
    // PDF logos are printed on white paper and must embed deterministically:
    // pdfkit's handling of PNG alpha is not byte-stable, and issued PDFs are
    // content-addressed. Flatten onto white (visually identical on paper) so
    // the stored PNG has no alpha channel. Web/PWA artwork keeps its alpha.
    if (purpose === 'PDF_LOGO') pipeline = pipeline.flatten({ background: '#ffffff' });
    const { data, info: output } = await pipeline.png().toBuffer({ resolveWithObject: true });
    if (data.length > 2 * 1024 * 1024 || output.width < 1 || output.height < 1) throw new Error('Image output too large');
    return { bytes: data, mimeType: 'image/png', width: output.width, height: output.height };
  } catch { throw new Error('Invalid image'); }
}

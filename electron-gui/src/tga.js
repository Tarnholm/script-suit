// Minimal TGA decoder, ported from Provincia's `src/tga.js` (originally by
// @ivoviz / @ScottyFillups). Handles 24/32-bit uncompressed (type 2) and
// RLE (type 10), with auto-flip of bottom-up images.
//
// Usage:
//   const tga = new TGA(new Uint8Array(buffer));
//   if (tga.width) ctx.putImageData(tga.getImageData(), 0, 0);

(function (root) {
  function TGA(data) {
    if (!(this instanceof TGA)) return new TGA(data);
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    this.width = 0;
    this.height = 0;
    this.pixels = null;
    this.hasAlpha = false;
    this.flags = 0;
    this.parse(data);
  }

  TGA.prototype.parse = function (data) {
    function getUint16(i) { return data[i] + (data[i + 1] << 8); }
    const idLength = data[0];
    const imageType = data[2];
    const width = getUint16(12);
    const height = getUint16(14);
    const pixelSize = data[16];
    const flags = data[17];

    if (data.length < 18 || width === 0 || height === 0 || width > 8192 || height > 8192) {
      return;
    }
    this.width = width;
    this.height = height;
    this.hasAlpha = pixelSize === 32;
    this.flags = flags;

    let offset = 18 + idLength;
    let pixels;
    const npixels = width * height;

    if ((imageType === 2 || imageType === 10) && (pixelSize === 24 || pixelSize === 32)) {
      if (imageType === 2) {
        // Uncompressed
        pixels = new Uint8Array(npixels * 4);
        for (let i = 0, p = 0; i < npixels; ++i, p += 4) {
          const b = data[offset++], g = data[offset++], r = data[offset++];
          const a = pixelSize === 32 ? data[offset++] : 255;
          pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = a;
        }
      } else {
        // RLE
        pixels = new Uint8Array(npixels * 4);
        let i = 0, p = 0;
        while (i < npixels) {
          const c = data[offset++];
          const count = (c & 0x7F) + 1;
          if (c & 0x80) {
            const b = data[offset++], g = data[offset++], r = data[offset++];
            const a = pixelSize === 32 ? data[offset++] : 255;
            for (let j = 0; j < count; ++j, ++i, p += 4) {
              pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = a;
            }
          } else {
            for (let j = 0; j < count; ++j, ++i, p += 4) {
              const b = data[offset++], g = data[offset++], r = data[offset++];
              const a = pixelSize === 32 ? data[offset++] : 255;
              pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = a;
            }
          }
        }
      }
    } else {
      this.width = 0; this.height = 0; this.pixels = null; this.flags = 0;
      return;
    }

    // Image origin (bit 5 == 0 → bottom-left, needs vertical flip)
    if (!(flags & 0x20)) {
      const stride = width * 4;
      const tmp = new Uint8Array(stride);
      for (let y = 0; y < Math.floor(height / 2); ++y) {
        const top = y * stride;
        const bot = (height - y - 1) * stride;
        tmp.set(pixels.slice(top, top + stride));
        pixels.set(pixels.slice(bot, bot + stride), top);
        pixels.set(tmp, bot);
      }
    }

    this.pixels = pixels;
  };

  TGA.prototype.getImageData = function () {
    return new ImageData(
      new Uint8ClampedArray(this.pixels.buffer, this.pixels.byteOffset, this.pixels.length),
      this.width,
      this.height
    );
  };

  root.TGA = TGA;
})(typeof window !== 'undefined' ? window : globalThis);

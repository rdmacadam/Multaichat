/* MC.files — turns a browser File into an attachment record: images are
   downscaled to the size limit, PDFs and text are read as they are. */
(function (MC) {
  'use strict';

  function readAs(file, how) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(`Could not read ${file.name}`));
      if (how === 'text') r.readAsText(file); else r.readAsDataURL(file);
    });
  }

  function hasAlpha(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
    return false;
  }

  async function readImage(file, maxSide) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error(`Could not read image ${file.name}`); }
    const { width, height } = bmp;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const isGif = file.type === 'image/gif';
    if (scale === 1 && !isGif) {
      bmp.close();
      return { data: await readAs(file), width, height, mime: file.type };
    }
    const w = Math.round(width * scale);
    const hgt = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, hgt);
    bmp.close();
    // GIF (first frame) and images with transparency stay PNG; everything else
    // becomes JPEG, which keeps large photos within providers' per-image limits.
    const mime = isGif || hasAlpha(ctx, w, hgt) ? 'image/png' : 'image/jpeg';
    return { data: canvas.toDataURL(mime, 0.85), width: w, height: hgt, mime };
  }

  async function read(file, limits = MC.attach.LIMITS) {
    const kind = MC.attach.classify(file);
    if (!kind) throw new Error(`${file.name}: unsupported file type`);
    const ref = { id: MC.util.uid('a_'), kind, name: file.name, mime: file.type || 'text/plain', size: file.size };
    let data;
    let text;
    if (kind === 'image') {
      const img = await readImage(file, limits.maxImageSide);
      Object.assign(ref, { mime: img.mime, width: img.width, height: img.height });
      data = img.data;
    } else if (kind === 'pdf') {
      ref.mime = 'application/pdf';
      data = await readAs(file);
    } else {
      // Read at most the limit: a huge log must not be loaded or stored whole.
      text = await readAs(file.slice(0, limits.maxTextBytes), 'text');
      if (file.size > limits.maxTextBytes) text += '\n…[truncated at 200 KB]';
      data = text;
    }
    return { ref, record: Object.assign({}, ref, { data, createdAt: Date.now() }), text };
  }

  function dataUrlBytes(url) {
    const b64 = String(url).slice(String(url).indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // data URL (or text) -> object URL for display/download; cached per id.
  const urls = new Map();
  async function objectUrl(record) {
    if (urls.has(record.id)) return urls.get(record.id);
    const type = MC.attach.blobType(record);
    const blob = record.kind === 'text' ? new Blob([record.data], { type }) : new Blob([dataUrlBytes(record.data)], { type });
    const u = URL.createObjectURL(blob);
    urls.set(record.id, u);
    return u;
  }

  MC.files = { read, objectUrl };
})(window.MC);

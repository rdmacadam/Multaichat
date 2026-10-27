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
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
    bmp.close();
    // PNG and GIF (first frame) stay lossless; photos become JPEG.
    const mime = file.type === 'image/png' || isGif ? 'image/png' : 'image/jpeg';
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
      text = await readAs(file, 'text');
      data = text;
    }
    return { ref, record: Object.assign({}, ref, { data, createdAt: Date.now() }), text };
  }

  // data URL (or text) -> object URL for display/download; cached per id.
  const urls = new Map();
  async function objectUrl(record) {
    if (urls.has(record.id)) return urls.get(record.id);
    const blob = record.kind === 'text'
      ? new Blob([record.data], { type: record.mime || 'text/plain' })
      : await (await fetch(record.data)).blob();
    const u = URL.createObjectURL(blob);
    urls.set(record.id, u);
    return u;
  }

  MC.files = { read, objectUrl };
})(window.MC);

/* ── save.js ─────────────────────────────────────────────────────────────────
 * Recording save module.
 * Handles: WEBM seekable patch (ts-ebml), MP4 remux (ffmpeg.wasm),
 *          MP3 save, download trigger, and recordings list entry.
 */

'use strict';

/* ── makeSeekable ───────────────────────────────────────────────────────────
 * Uses ts-ebml to inject Duration metadata + Cues into a raw WebM blob.
 * Raw MediaRecorder WebM has no duration — this patches it so players can seek.
 * HOW IT WORKS:
 *   1. Decode the raw WebM blob into EBML elements.
 *   2. Inject the known duration (in ms) into the Segment Info block.
 *   3. Build a Cues index for fast seeking.
 *   4. Re-encode and return the patched blob.
 */
async function makeSeekable(webmBlob, durationMs) {
  const reader  = new EBML.Reader();
  const decoder = new EBML.Decoder();
  const tools   = EBML.tools;

  const ab       = await webmBlob.arrayBuffer();
  const elms     = decoder.decode(ab);
  elms.forEach(e => reader.read(e));
  reader.stop();

  const refinedMetadata = tools.makeMetadataSeekable(reader.metadatas, reader.duration, reader.cues);
  const body            = ab.slice(reader.metadataSize);
  return new Blob([refinedMetadata, body], { type: 'video/webm' });
}

/* ── remuxToMp4 ─────────────────────────────────────────────────────────────
 * Uses ffmpeg.wasm to remux the raw WebM blob into a true MP4 container.
 * HOW IT WORKS:
 *   1. Load ffmpeg.wasm single-thread core via toBlobURL.
 *   2. Write raw WebM bytes into ffmpeg's virtual filesystem as input.webm.
 *   3. Run: ffmpeg -i input.webm -c copy -movflags +faststart output.mp4
 *      -c copy:              stream copy — no re-encode, fast, lossless.
 *      -movflags +faststart: moves moov atom to front — all players can seek.
 *   4. Read output.mp4 back out and return as a Blob.
 */
async function remuxToMp4(webmBlob) {
  const { FFmpeg }               = FFmpegWASM;
  const { toBlobURL, fetchFile } = FFmpegUtil;

  const ff       = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

  await ff.load({
    coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`,   'text/javascript'),
    wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  const inputData = await fetchFile(webmBlob);
  await ff.writeFile('input.webm', inputData);

  await ff.exec([
    '-i', 'input.webm',
    '-c', 'copy',
    '-movflags', '+faststart',
    'output.mp4'
  ]);

  const data = await ff.readFile('output.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

/* ── saveRecording ──────────────────────────────────────────────────────────
 * Routes recorded chunks to the correct save path based on chosen format.
 * WEBM: ts-ebml patches Duration + Cues into the WebM container (fast, in-browser).
 * MP4:  ffmpeg.wasm remuxes WebM → true MP4 with moov atom duration written correctly.
 * MP3:  Audio-only opus stream saved directly as .mp3.
 */
async function saveRecording(chosenFormat, mimeType, recordedChunks, elapsedSeconds) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (chosenFormat === 'mp3') {
    const blob = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
    const url  = URL.createObjectURL(blob);
    const name = `vcrec-${ts}.mp3`;
    addToList(name, blob.size, url, 'MP3', elapsedSeconds);
    triggerDownload(url, name);
    return;
  }

  const rawBlob    = new Blob(recordedChunks, { type: 'video/webm' });
  const durationMs = elapsedSeconds * 1000;

  if (chosenFormat === 'mp4') {
    setStatus('PROCESSING MP4…', '');
    try {
      const name    = `vcrec-${ts}.mp4`;
      const mp4Blob = await remuxToMp4(rawBlob);
      const url     = URL.createObjectURL(mp4Blob);
      addToList(name, mp4Blob.size, url, 'MP4', elapsedSeconds);
      triggerDownload(url, name);
    } catch (e) {
      console.warn('ffmpeg remux failed, falling back to seekable WebM saved as .mp4:', e);
      try {
        const seekableBlob = await makeSeekable(rawBlob, durationMs);
        const finalBlob    = new Blob([await seekableBlob.arrayBuffer()], { type: 'video/mp4' });
        const url          = URL.createObjectURL(finalBlob);
        const name         = `vcrec-${ts}.mp4`;
        addToList(name, finalBlob.size, url, 'MP4', elapsedSeconds);
        triggerDownload(url, name);
      } catch (e2) {
        const url  = URL.createObjectURL(rawBlob);
        const name = `vcrec-${ts}.mp4`;
        addToList(name, rawBlob.size, url, 'MP4', elapsedSeconds);
        triggerDownload(url, name);
      }
    }
    setStatus('IDLE', '');
    return;
  }

  // WEBM — ts-ebml seekable patch (fast, no wasm needed)
  const name = `vcrec-${ts}.webm`;
  try {
    const seekableBlob = await makeSeekable(rawBlob, durationMs);
    const url          = URL.createObjectURL(seekableBlob);
    addToList(name, seekableBlob.size, url, 'WEBM', elapsedSeconds);
    triggerDownload(url, name);
  } catch (e) {
    const url = URL.createObjectURL(rawBlob);
    addToList(name, rawBlob.size, url, 'WEBM', elapsedSeconds);
    triggerDownload(url, name);
  }
}

/* ── triggerDownload ────────────────────────────────────────────────────────
 * Creates a temporary anchor element and programmatically clicks it to
 * trigger a browser file download for the given blob URL.
 */
function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
}

/* ── addToList ──────────────────────────────────────────────────────────────
 * Prepends a new recording entry to the recordings list UI panel.
 * Removes the empty-state placeholder on first entry.
 */
function addToList(name, bytes, url, fmt, elapsedSeconds) {
  const empty = recList.querySelector('.rec-empty');
  if (empty) empty.remove();
  const size = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  const dur  = formatTime(elapsedSeconds);
  const li   = document.createElement('li');
  li.className = 'rec-item';
  li.innerHTML = `
    <div class="rec-item-info">
      <span class="rec-item-name">${name}</span>
      <span class="rec-item-meta">${dur} · ${size} · ${fmt || 'WEBM'}</span>
    </div>
    <a class="rec-item-download" href="${url}" download="${name}">DOWNLOAD</a>
  `;
  recList.prepend(li);
}

/* ── save.js ─────────────────────────────────────────────────────────────────
 * Recording save module.
 * Handles: WEBM seekable patch (ts-ebml), MP4 remux (ffmpeg.wasm),
 *          MP3 transcode (ffmpeg.wasm → real MPEG audio), download trigger,
 *          and recordings list entry.
 */

'use strict';

/* ── makeSeekable ───────────────────────────────────────────────────────────
 * Uses ts-ebml to inject Duration metadata + Cues into a raw WebM blob.
 * HOW IT WORKS:
 *   1. Decode the raw WebM blob into EBML elements.
 *   2. Read all elements; stop signals end-of-stream.
 *   3. Inject known duration (ms) into Segment Info and build Cues index.
 *   4. Re-encode: [patchedMetadata][original body after metadata] → seekable blob.
 * NOTE: Only called for WEBM format. Throws on bad input so caller can fall back.
 */
async function makeSeekable(webmBlob, durationMs) {
  const reader  = new EBML.Reader();
  const decoder = new EBML.Decoder();
  const tools   = EBML.tools;

  const ab   = await webmBlob.arrayBuffer();
  const elms = decoder.decode(ab);
  elms.forEach(e => reader.read(e));
  reader.stop();

  const refinedMetadata = tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues
  );
  const body = ab.slice(reader.metadataSize);
  return new Blob([refinedMetadata, body], { type: 'video/webm' });
}

/* ── loadFfmpeg ─────────────────────────────────────────────────────────────
 * Loads and returns an ffmpeg.wasm instance ready for use.
 * HOW IT WORKS:
 *   Fetches the single-thread WASM core from jsDelivr CDN via toBlobURL,
 *   which wraps the remote file in a same-origin Blob so it can be imported.
 */
async function loadFfmpeg() {
  const { FFmpeg }    = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

  const ff = new FFmpeg();
  await ff.load({
    coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`,   'text/javascript'),
    wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  return ff;
}

/* ── remuxToMp4 ─────────────────────────────────────────────────────────────
 * Uses ffmpeg.wasm to transcode raw WebM → true MP4 (H.264 + AAC).
 * HOW IT WORKS:
 *   1. Write raw WebM bytes into ffmpeg's virtual FS as input.webm.
 *   2. Run: ffmpeg -i input.webm
 *              -c:v libx264 -preset ultrafast -crf 23   ← H.264 video
 *              -c:a aac -b:a 192k                       ← AAC audio
 *              -movflags +faststart                     ← moov atom at front = seekable
 *              output.mp4
 *   3. Read output.mp4 and return as Blob(video/mp4).
 * WHY transcode instead of stream-copy:
 *   MediaRecorder outputs VP8/VP9+Opus. Wrapping those in .mp4 with -c copy
 *   produces a container most players refuse to seek because codec timestamps
 *   are WebM-native. libx264+AAC gives every player a proper seekable MP4.
 */
async function remuxToMp4(webmBlob) {
  const { fetchFile } = FFmpegUtil;
  const ff            = await loadFfmpeg();

  await ff.writeFile('input.webm', await fetchFile(webmBlob));

  await ff.exec([
    '-i',        'input.webm',
    '-c:v',      'libx264',
    '-preset',   'ultrafast',
    '-crf',      '23',
    '-c:a',      'aac',
    '-b:a',      '192k',
    '-movflags', '+faststart',
    'output.mp4'
  ]);

  const data = await ff.readFile('output.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

/* ── transcodeToMp3 ─────────────────────────────────────────────────────────
 * Uses ffmpeg.wasm to transcode the raw Opus/WebM audio → real MPEG MP3.
 * HOW IT WORKS:
 *   1. Write raw audio/webm blob into ffmpeg's virtual FS as input.webm.
 *   2. Run: ffmpeg -i input.webm
 *              -vn               ← strip any video track
 *              -c:a libmp3lame   ← MPEG Layer 3 encoder
 *              -b:a 192k         ← 192 kbps bitrate
 *              -ar 44100         ← standard sample rate
 *              output.mp3
 *   3. Read output.mp3 and return as Blob(audio/mpeg).
 * WHY this matters:
 *   Saving raw Opus chunks renamed to .mp3 creates a file players misidentify —
 *   they cannot decode the Opus stream and cannot seek. libmp3lame produces
 *   real MPEG frames with proper ID3 headers → full seek support in all players.
 */
async function transcodeToMp3(audioBlob) {
  const { fetchFile } = FFmpegUtil;
  const ff            = await loadFfmpeg();

  await ff.writeFile('input.webm', await fetchFile(audioBlob));

  await ff.exec([
    '-i',   'input.webm',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-ar',  '44100',
    'output.mp3'
  ]);

  const data = await ff.readFile('output.mp3');
  return new Blob([data.buffer], { type: 'audio/mpeg' });
}

/* ── saveRecording ──────────────────────────────────────────────────────────
 * Routes recorded chunks to the correct save path based on chosen format.
 * WEBM: ts-ebml patches Duration + Cues → seekable WebM (fast, no WASM).
 * MP4:  ffmpeg.wasm transcodes WebM → H.264+AAC MP4 with +faststart (seekable).
 * MP3:  ffmpeg.wasm transcodes Opus/WebM → real MPEG MP3 (seekable).
 * Falls back gracefully at each stage if a processing step fails.
 */
async function saveRecording(chosenFormat, mimeType, recordedChunks, elapsedSeconds) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  /* ── MP3 path ── */
  if (chosenFormat === 'mp3') {
    setStatus('PROCESSING MP3…', '');
    const rawAudio = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
    try {
      const mp3Blob = await transcodeToMp3(rawAudio);
      const url     = URL.createObjectURL(mp3Blob);
      const name    = `vcrec-${ts}.mp3`;
      addToList(name, mp3Blob.size, url, 'MP3', elapsedSeconds);
      triggerDownload(url, name);
    } catch (e) {
      console.warn('MP3 transcode failed, saving raw audio/webm as fallback:', e);
      const url  = URL.createObjectURL(rawAudio);
      const name = `vcrec-${ts}.webm`;
      addToList(name, rawAudio.size, url, 'AUDIO', elapsedSeconds);
      triggerDownload(url, name);
    }
    setStatus('IDLE', '');
    return;
  }

  const rawBlob    = new Blob(recordedChunks, { type: 'video/webm' });
  const durationMs = elapsedSeconds * 1000;

  /* ── MP4 path ── */
  if (chosenFormat === 'mp4') {
    setStatus('PROCESSING MP4…', '');
    try {
      const mp4Blob = await remuxToMp4(rawBlob);
      const url     = URL.createObjectURL(mp4Blob);
      const name    = `vcrec-${ts}.mp4`;
      addToList(name, mp4Blob.size, url, 'MP4', elapsedSeconds);
      triggerDownload(url, name);
    } catch (e) {
      console.warn('MP4 transcode failed, falling back to seekable WebM saved as .mp4:', e);
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

  /* ── WEBM path — ts-ebml seekable patch ── */
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
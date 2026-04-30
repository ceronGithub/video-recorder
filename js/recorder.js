/* ===================================================
   VCREC — Video Call Recorder
   - Saves as .webm (VP9+Opus) — plays in Chrome, Edge, VLC
   - MIC    = your microphone (getUserMedia)
   - CALLER = other person's audio, two capture methods:
       A) Tab mode  → getDisplayMedia (Chrome Tab + Share tab audio)
       B) Loopback  → VB-Cable / Stereo Mix via getUserMedia
                      REQUIRED for MS Teams, Zoom, Skype desktop apps
   =================================================== */

'use strict';

// ── DOM refs ──────────────────────────────────────────
const statusBar          = document.getElementById('statusBar');
const previewVideo       = document.getElementById('previewVideo');
const previewPh          = document.getElementById('previewPlaceholder');
const recBadge           = document.getElementById('recBadge');
const recTimer           = document.getElementById('recTimer');
const micMeter           = document.getElementById('micMeter');
const sysMeter           = document.getElementById('sysMeter');
const btnStart           = document.getElementById('btnStart');
const btnStop            = document.getElementById('btnStop');
const btnPause           = document.getElementById('btnPause');
const recList            = document.getElementById('recList');
const includeMic         = document.getElementById('includeMic');
const qualitySelect      = document.getElementById('qualitySelect');
const srcBtns            = document.querySelectorAll('.src-btn');
const micVolumeSlider    = document.getElementById('micVolume');
const callerVolumeSlider = document.getElementById('callerVolume');
const micVolPct          = document.getElementById('micVolPct');
const callerVolPct       = document.getElementById('callerVolPct');
const callerDeviceSelect = document.getElementById('callerDeviceSelect');
const callerDeviceRow    = document.getElementById('callerDeviceRow');
const btnRefreshDevices  = document.getElementById('btnRefreshDevices');
const loopbackWarning    = document.getElementById('loopbackWarning');
const fmtTag             = document.getElementById('fmtTag');

// ── Format helpers ────────────────────────────────────
function getChosenFormat() {
  const r = document.querySelector('input[name="outputFormat"]:checked');
  return r ? r.value : 'webm'; // 'webm' | 'mp4' | 'mp3'
}

// Update the fmt tag badge when format changes
document.querySelectorAll('input[name="outputFormat"]').forEach(r => {
  r.addEventListener('change', () => {
    const labels = { webm: 'WEBM · VP9+Opus', mp4: 'MP4 · H.264+AAC', mp3: 'MP3 · Audio Only' };
    if (fmtTag) fmtTag.textContent = labels[getChosenFormat()] || 'WEBM';
  });
});

// ── State ─────────────────────────────────────────────
let mediaRecorder    = null;
let recordedChunks   = [];
let timerInterval    = null;
let elapsedSeconds   = 0;
let isPaused         = false;
let activeMode       = 'screen';
let screenStream     = null;
let micStream        = null;
let loopbackStream   = null;

// AudioContext nodes — built on START, torn down on STOP
let audioCtx        = null;
let micGain         = null;
let callerGain      = null;
let micAnalyser     = null;
let sysAnalyser     = null;
let animFrame       = null;

// ── Volume slider max = 400 → gain 4.0 (real boost headroom) ──
// Slider value 100 = gain 1.0 (unity), 400 = gain 4.0
const SLIDER_MAX = 400;
micVolumeSlider.max    = SLIDER_MAX;
callerVolumeSlider.max = SLIDER_MAX;

// ── Populate loopback device dropdown ────────────────
// Lists all audioinput devices. VB-Cable / Stereo Mix entries are starred.
// Required for recording desktop apps (Teams, Zoom) in Entire Screen mode.
async function populateDevices() {
  try {
    // Trigger mic permission so device labels are visible (not blank)
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');

    callerDeviceSelect.innerHTML = '<option value="">— None —</option>';
    inputs.forEach(d => {
      const opt  = document.createElement('option');
      opt.value  = d.deviceId;
      opt.text   = d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`;
      // Auto-star known loopback devices for easy identification
      if (/vb-?cable|stereo.?mix|loopback|virtual|wave out/i.test(d.label)) {
        opt.text = '★ ' + opt.text;
      }
      callerDeviceSelect.appendChild(opt);
    });
  } catch (e) {
    console.warn('Device enumeration failed:', e);
  }
}

populateDevices();
btnRefreshDevices.addEventListener('click', populateDevices);

// ── Show/hide loopback row + warning based on mode ────
function updateLoopbackUI() {
  const needsLoopback = (activeMode === 'screen' || activeMode === 'window');
  callerDeviceRow.style.display  = needsLoopback ? 'flex' : 'none';
  // Show warning only if screen/window mode AND no loopback device chosen
  updateLoopbackWarning();
}

// Warns the user that desktop apps (Teams, Zoom) require a loopback device
function updateLoopbackWarning() {
  if (!loopbackWarning) return;
  const needsLoopback = (activeMode === 'screen' || activeMode === 'window');
  const hasDevice     = callerDeviceSelect.value !== '';
  loopbackWarning.style.display = (needsLoopback && !hasDevice) ? 'block' : 'none';
}

callerDeviceSelect.addEventListener('change', updateLoopbackWarning);

// ── Volume slider listeners ───────────────────────────
micVolumeSlider.addEventListener('input', () => {
  const v = parseInt(micVolumeSlider.value, 10);
  micVolPct.textContent = v + '%';
  if (micGain) micGain.gain.setTargetAtTime(v / 100, audioCtx.currentTime, 0.01);
});
callerVolumeSlider.addEventListener('input', () => {
  const v = parseInt(callerVolumeSlider.value, 10);
  callerVolPct.textContent = v + '%';
  if (callerGain) callerGain.gain.setTargetAtTime(v / 100, audioCtx.currentTime, 0.01);
});

// ── Source mode selection ─────────────────────────────
srcBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    srcBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeMode = btn.dataset.mode;
    updateLoopbackUI();
  });
});
updateLoopbackUI();

// ── Timer ─────────────────────────────────────────────
function formatTime(s) {
  const h   = String(Math.floor(s / 3600)).padStart(2, '0');
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function startTimer() {
  elapsedSeconds = 0;
  recTimer.textContent = formatTime(0);
  timerInterval = setInterval(() => {
    if (!isPaused) { elapsedSeconds++; recTimer.textContent = formatTime(elapsedSeconds); }
  }, 1000);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

// ── Audio pipeline ────────────────────────────────────
// MIC chain:    Source → Gain → HighPass(80Hz) → LowShelf(-6dB@200Hz)
//                      → Peaking(+4dB@3kHz) → HighShelf(+3dB@6kHz) → Compressor → Dest
//
// CALLER chain: Source → Gain → HighPass(80Hz) → Peaking(+4dB@3kHz)
//                      → HighShelf(+3dB@6kHz) → Compressor → Dest
//
// KEY FIX: Gain is now FIRST — user volume boost happens before the compressor.
//          Previously gain was after compressor, so 400% was boosting an already-
//          squashed signal. Now 400% raises the input into the compressor, giving
//          true loudness increase.
//
// CALLER skips the LowShelf(-6dB) mud cut — loopback/tab audio is already
// processed by the call app and doesn't have the low-end boominess a raw mic has.
// Removing the -6dB cut recovers significant perceived volume on the caller side.
function buildVoiceChain(ctx, sourceNode, gainNode, dest, isCaller) {
  // 1. Gain first — user volume control before any processing
  gainNode.connect; // already created outside, wired below

  // 2. High-pass: cut rumble below 80Hz
  const hp = ctx.createBiquadFilter();
  hp.type            = 'highpass';
  hp.frequency.value = 80;
  hp.Q.value         = 0.7;

  // 3. Low-shelf mud cut — MIC only (caller audio is already processed by call app)
  const mud = ctx.createBiquadFilter();
  mud.type            = 'lowshelf';
  mud.frequency.value = 200;
  mud.gain.value      = isCaller ? 0 : -6;  // skip cut for caller

  // 4. Peaking: boost presence at 3kHz
  const presence = ctx.createBiquadFilter();
  presence.type            = 'peaking';
  presence.frequency.value = 3000;
  presence.Q.value         = 1.0;
  presence.gain.value      = 4;

  // 5. High-shelf: add air above 6kHz
  const air = ctx.createBiquadFilter();
  air.type            = 'highshelf';
  air.frequency.value = 6000;
  air.gain.value      = 3;

  // 6. Compressor last — limits peaks AFTER gain boost, prevents clipping
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;  // raised from -24 so quieter signals aren't squashed
  comp.knee.value      = 8;
  comp.ratio.value     = 3;    // gentler ratio so boost is more audible
  comp.attack.value    = 0.005;
  comp.release.value   = 0.3;

  // Wire: source → gain → hp → mud → presence → air → comp → dest
  sourceNode.connect(gainNode);
  gainNode.connect(hp);
  hp.connect(mud);
  mud.connect(presence);
  presence.connect(air);
  air.connect(comp);
  comp.connect(dest);

  return comp;
}

function buildAudioPipeline(micStreamIn, callerStreamIn) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = audioCtx.createMediaStreamDestination();

  micGain    = audioCtx.createGain();
  callerGain = audioCtx.createGain();
  micGain.gain.value    = parseInt(micVolumeSlider.value, 10) / 100;
  callerGain.gain.value = parseInt(callerVolumeSlider.value, 10) / 100;

  micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 256;
  sysAnalyser = audioCtx.createAnalyser(); sysAnalyser.fftSize = 256;

  if (micStreamIn && micStreamIn.getAudioTracks().length > 0) {
    const src  = audioCtx.createMediaStreamSource(micStreamIn);
    const comp = buildVoiceChain(audioCtx, src, micGain, dest, false);
    comp.connect(micAnalyser);
  }

  if (callerStreamIn && callerStreamIn.getAudioTracks().length > 0) {
    const src = audioCtx.createMediaStreamSource(callerStreamIn);
    // Pre-boost: caller audio enters at a lower level than mic (no hardware AGC).
    // +8dB fixed boost before the voice chain to match baseline levels.
    // This is separate from callerGain (the user slider) — it's a fixed offset.
    const preBoost = audioCtx.createGain();
    preBoost.gain.value = 2.5; // ~+8dB baseline
    src.connect(preBoost);
    // buildVoiceChain expects a real AudioNode as source — pass preBoost as the source
    // by temporarily wrapping: source → preBoost → gainNode → EQ → comp → dest
    const comp = buildVoiceChain(audioCtx, preBoost, callerGain, dest, true);
    comp.connect(sysAnalyser);
  }

  // VU meter animation
  const buf = new Uint8Array(256);
  function draw() {
    animFrame = requestAnimationFrame(draw);
    micAnalyser.getByteFrequencyData(buf);
    micMeter.style.width  = Math.min(buf.reduce((a, b) => a + b, 0) / buf.length * 2.5, 100) + '%';
    sysAnalyser.getByteFrequencyData(buf);
    sysMeter.style.width  = Math.min(buf.reduce((a, b) => a + b, 0) / buf.length * 2.5, 100) + '%';
  }
  draw();

  return dest.stream;
}

function teardownAudio() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  micMeter.style.width = '0%';
  sysMeter.style.width = '0%';
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  micGain = null; callerGain = null;
  micAnalyser = null; sysAnalyser = null;
}

// ── START ─────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  try {
    setStatus('CAPTURING…', '');

    let displayStream = null;
    let cameraStream  = null;
    loopbackStream    = null;

    // Step 1: Capture video source
    // displaySurface hint pre-selects the correct tab in Chrome's share dialog:
    //   'monitor' -> Entire Screen tab, "Also share system audio" toggle pre-enabled
    //   'window'  -> Window tab
    //   'browser' -> Chrome Tab tab, "Also share tab audio" toggle shown
    // selfBrowserSurface:'exclude' hides the VCREC tab from the picker list.
    if (activeMode === 'screen') {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', cursor: 'always' },
        audio: { suppressLocalAudioPlayback: false },
        selfBrowserSurface: 'exclude',
        systemAudio: 'include'
      });
    } else if (activeMode === 'window') {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', cursor: 'always' },
        audio: true,
        selfBrowserSurface: 'exclude'
      });
    } else if (activeMode === 'screentabmic') {
      // Opens on Chrome Tab tab with tab audio toggle shown
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', cursor: 'always' },
        audio: true,
        selfBrowserSurface: 'exclude'
      });
    } else if (activeMode === 'camera') {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    }

    // Step 2: Capture microphone — hardware noise cancellation ON
    // echoCancellation: removes speaker bleed picked up by mic
    // noiseSuppression: removes background noise (fans, AC, keyboard)
    // autoGainControl:  normalizes mic input level automatically
    const forceMic = (activeMode === 'screentabmic' || activeMode === 'camera');
    let micStreamLocal = null;
    if (forceMic || includeMic.checked) {
      try {
        micStreamLocal = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation:    true,
            noiseSuppression:    true,
            autoGainControl:     false, // OFF — hardware AGC inflates mic before WebAudio;
                                        // the volume slider handles gain uniformly for both tracks
            channelCount:        1,
            sampleRate:          48000,
            sampleSize:          16
          },
          video: false
        });
      } catch (e) { console.warn('Mic unavailable:', e); }
    }

    // Step 3: Capture loopback device as CALLER audio source
    // VB-Cable / Stereo Mix routes speaker output back as a mic input.
    // Audio processing OFF on loopback — we want the raw speaker signal, not filtered.
    const loopbackDeviceId = callerDeviceSelect.value;
    if (loopbackDeviceId && (activeMode === 'screen' || activeMode === 'window')) {
      try {
        loopbackStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:          { exact: loopbackDeviceId },
            echoCancellation:  false,
            noiseSuppression:  false,
            autoGainControl:   false
          },
          video: false
        });
      } catch (e) { console.warn('Loopback device unavailable:', e); }
    }

    screenStream = displayStream || cameraStream;
    micStream    = micStreamLocal;

    // Step 4: Pick caller audio source — loopback takes priority over tab audio
    const tabAudio          = (displayStream && displayStream.getAudioTracks().length > 0) ? displayStream : null;
    const callerAudioStream = loopbackStream || tabAudio;

    // Step 5: Build audio pipeline with gain + compressor
    const hasAnyAudio = micStreamLocal || callerAudioStream;
    let processedAudioStream = null;
    if (hasAnyAudio) {
      processedAudioStream = buildAudioPipeline(micStreamLocal, callerAudioStream);
    }

    // Step 6: Combine video + processed audio
    const chosenFormat = getChosenFormat(); // 'webm' | 'mp4' | 'mp3'
    const videoTrack   = (chosenFormat !== 'mp3' && screenStream)
      ? screenStream.getVideoTracks()[0] : null;
    const allTracks    = [videoTrack].filter(Boolean);
    if (processedAudioStream) {
      processedAudioStream.getAudioTracks().forEach(t => allTracks.push(t));
    }
    const combined = new MediaStream(allTracks);

    // ── Show live preview immediately ──
    // Use the raw screenStream for preview so the video is visible right away.
    // The combined (processed audio) stream is what gets recorded.
    const previewStream = screenStream
      ? new MediaStream([
          ...(screenStream.getVideoTracks()),
          ...(combined.getAudioTracks())
        ])
      : combined;
    previewVideo.srcObject = previewStream;
    previewVideo.classList.add('active');
    previewPh.classList.add('hidden');
    // Ensure video plays (autoplay policy may require explicit play call)
    previewVideo.play().catch(() => {});

    // Step 7: Determine mimeType based on chosen format
    // Chrome MediaRecorder cannot natively encode H.264/AAC (MP4) or MP3.
    // MP3  → record as audio/webm;codecs=opus (audio-only, no video tracks)
    // MP4  → record as video/webm;codecs=vp9,opus (best Chrome can do)
    //         saved with .mp4 extension — plays in VLC, Windows Media Player
    // WEBM → video/webm;codecs=vp9,opus (native, best quality)
    let mimeType;
    if (chosenFormat === 'mp3') {
      // Audio-only: strip all video tracks, record pure opus audio
      mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    } else {
      // Both WEBM and MP4 use the same webm container — MP4 gets renamed on save
      mimeType = getBestWebM();
    }

    const bitrate  = parseInt(qualitySelect.value, 10);
    recordedChunks = [];

    const recOptions = { mimeType, audioBitsPerSecond: 192000 };
    if (chosenFormat !== 'mp3') recOptions.videoBitsPerSecond = bitrate;

    mediaRecorder = new MediaRecorder(combined, recOptions);

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => { saveRecording(chosenFormat, mimeType); };
    mediaRecorder.start(500);

    if (videoTrack) {
      videoTrack.onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      };
    }

    isPaused = false;
    startTimer();
    recBadge.classList.add('visible');
    recTimer.classList.add('visible');

    // Show CALLER status in status bar so user knows if caller audio is active
    const callerSrc = loopbackStream ? 'LOOPBACK' : (tabAudio ? 'TAB AUDIO' : 'NO CALLER AUDIO');
    setStatus(`RECORDING · ${callerSrc}`, 'recording');

    btnStart.disabled    = true;
    btnStop.disabled     = false;
    btnPause.disabled    = false;
    btnPause.textContent = 'PAUSE';

  } catch (err) {
    console.error('Capture error:', err);
    setStatus('ERROR — ' + err.message, '');
  }
});

// ── PAUSE / RESUME ────────────────────────────────────
btnPause.addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (!isPaused) {
    mediaRecorder.pause(); isPaused = true;
    btnPause.textContent = 'RESUME';
    setStatus('PAUSED', 'paused');
  } else {
    mediaRecorder.resume(); isPaused = false;
    btnPause.textContent = 'PAUSE';
    setStatus('RECORDING', 'recording');
  }
});

// ── STOP ──────────────────────────────────────────────
btnStop.addEventListener('click', stopRecording);

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  [screenStream, micStream, loopbackStream].forEach(s => {
    if (s) s.getTracks().forEach(t => t.stop());
  });
  screenStream = null; micStream = null; loopbackStream = null;
  stopTimer();
  teardownAudio();
  previewVideo.srcObject = null;
  previewVideo.classList.remove('active');
  previewPh.classList.remove('hidden');
  recBadge.classList.remove('visible');
  recTimer.classList.remove('visible');
  setStatus('IDLE', '');
  btnStart.disabled    = false;
  btnStop.disabled     = true;
  btnPause.disabled    = true;
  btnPause.textContent = 'PAUSE';
  isPaused = false;
}

// ── SAVE — with format handling + seekable fix ────────
async function saveRecording(chosenFormat, mimeType) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (chosenFormat === 'mp3') {
    // Audio-only opus stream saved as .mp3
    // MIME must be audio/webm — not audio/mpeg — so the browser plays it back correctly
    const blob = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
    const url  = URL.createObjectURL(blob);
    const name = `vcrec-${ts}.mp3`;
    addToList(name, blob.size, url, 'MP3');
    triggerDownload(url, name);
    return;
  }

  // Video formats — inject seekable metadata via ts-ebml
  const rawBlob = new Blob(recordedChunks, { type: 'video/webm' });
  const ext     = chosenFormat === 'mp4' ? 'mp4' : 'webm';
  const name    = `vcrec-${ts}.${ext}`;

  try {
    const seekableBlob = await makeSeekable(rawBlob);
    // For MP4 choice: if MediaRecorder actually encoded mp4, use it directly.
    // Otherwise we save the seekable webm with .mp4 extension — plays in most players.
    const finalBlob = new Blob([await seekableBlob.arrayBuffer()],
      { type: chosenFormat === 'mp4' ? 'video/mp4' : 'video/webm' });
    const url = URL.createObjectURL(finalBlob);
    addToList(name, finalBlob.size, url, ext.toUpperCase());
    triggerDownload(url, name);
  } catch (e) {
    console.warn('Seekable fix failed, saving raw:', e);
    const url = URL.createObjectURL(rawBlob);
    addToList(name, rawBlob.size, url, ext.toUpperCase());
    triggerDownload(url, name);
  }
}

// Injects Duration + Cues into a WebM blob using ts-ebml
function makeSeekable(blob) {
  return new Promise((resolve, reject) => {
    const reader    = new FileReader();
    reader.onload   = () => {
      try {
        const buf      = reader.result;
        const decoder  = new EBML.Decoder();
        const reader2  = new EBML.Reader();
        reader2.logging = false;
        reader2.drop_default_duration = false;

        const elms = decoder.decode(buf);
        elms.forEach(e => reader2.read(e));
        reader2.stop();

        const refined = EBML.tools.makeMetadataSeekable(
          reader2.metadatas, reader2.duration, reader2.cues
        );
        const body = buf.slice(reader2.metadataSize);
        const seekableBlob = new Blob([refined, body], { type: 'video/webm' });
        resolve(seekableBlob);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
}

function addToList(name, bytes, url, fmt) {
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

function getBestWebM() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function setStatus(text, cls) {
  statusBar.textContent = text;
  statusBar.className   = 'status-bar' + (cls ? ' ' + cls : '');
}

if (!navigator.mediaDevices?.getDisplayMedia) {
  setStatus('ERROR — Browser not supported', '');
  btnStart.disabled = true;
  alert('Your browser does not support screen capture.\nPlease use Chrome, Edge, or Firefox.');
}
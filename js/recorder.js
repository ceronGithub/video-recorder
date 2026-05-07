/* ===================================================
   VCREC — Video Call Recorder  |  recorder.js
   Orchestration only. All sub-processes live in:
     dom.js     → DOM references
     devices.js → device enumeration + source mode
     audio.js   → mic/caller chains + audio pipeline
     save.js    → WEBM/MP4/MP3 save + recordings list
   =================================================== */

'use strict';

/* ── State ───────────────────────────────────────────────────────────────── */
let mediaRecorder  = null;
let recordedChunks = [];
let timerInterval  = null;
let elapsedSeconds = 0;
let isPaused       = false;
let screenStream   = null;
let micStream      = null;
let loopbackStream = null;

/* ── Volume slider max = 400 → gain 4.0 (real boost headroom) ──────────── */
const SLIDER_MAX = 400;
micVolumeSlider.max    = SLIDER_MAX;
callerVolumeSlider.max = SLIDER_MAX;

/* ── formatTime ─────────────────────────────────────────────────────────────
 * Converts total seconds into HH:MM:SS string for the timer display.
 */
function formatTime(s) {
  const h   = String(Math.floor(s / 3600)).padStart(2, '0');
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

/* ── startTimer / stopTimer ─────────────────────────────────────────────────
 * Starts a 1-second interval that increments elapsedSeconds and updates the
 * timer display. Paused state skips increments without clearing the interval.
 */
function startTimer() {
  elapsedSeconds = 0;
  recTimer.textContent = formatTime(0);
  timerInterval = setInterval(() => {
    if (!isPaused) { elapsedSeconds++; recTimer.textContent = formatTime(elapsedSeconds); }
  }, 1000);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

/* ── setStatus ──────────────────────────────────────────────────────────────
 * Updates the status bar text and CSS class for visual state feedback.
 */
function setStatus(text, cls) {
  statusBar.textContent = text;
  statusBar.className   = 'status-bar' + (cls ? ' ' + cls : '');
}

/* ── getChosenFormat ────────────────────────────────────────────────────────
 * Returns the currently selected output format radio value: 'webm'|'mp4'|'mp3'.
 */
function getChosenFormat() {
  const r = document.querySelector('input[name="outputFormat"]:checked');
  return r ? r.value : 'webm';
}

/* ── getBestWebM ────────────────────────────────────────────────────────────
 * Returns the best supported VP9+Opus MIME type for MediaRecorder.
 */
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

/* ── Format tag badge update ────────────────────────────────────────────────
 * Updates the WEBM/MP4/MP3 badge label whenever the output format radio changes.
 */
document.querySelectorAll('input[name="outputFormat"]').forEach(r => {
  r.addEventListener('change', () => {
    const labels = { webm: 'WEBM · VP9+Opus', mp4: 'MP4 · H.264+AAC', mp3: 'MP3 · Audio Only' };
    if (fmtTag) fmtTag.textContent = labels[getChosenFormat()] || 'WEBM';
  });
});

/* ── Volume slider listeners ────────────────────────────────────────────────
 * Updates the percentage label and applies gain change to the live GainNode.
 * Uses setTargetAtTime for smooth, click-free gain transitions.
 */
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

/* ── Amp buttons — x1 to x5 multiplier on top of volume slider ─────────────
 * Each group of buttons toggles an .active class on click.
 * The selected multiplier is applied to the GainNode factored with the slider %.
 */
(function initAmpButtons() {
  let micAmp    = 1;
  let callerAmp = 1;

  /* wireGroup — wires a set of amp buttons and calls onChange with the selected value */
  function wireGroup(containerId, onChange) {
    const container = document.getElementById(containerId);
    container.querySelectorAll('.amp-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.amp-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(parseInt(btn.dataset.val, 10));
      });
    });
  }

  wireGroup('micAmpBtns', val => {
    micAmp = val;
    if (micGain) {
      const sliderPct = parseInt(micVolumeSlider.value, 10) / 100;
      micGain.gain.setTargetAtTime(sliderPct * micAmp, audioCtx.currentTime, 0.01);
    }
  });

  wireGroup('callerAmpBtns', val => {
    callerAmp = val;
    if (callerGain) {
      const sliderPct = parseInt(callerVolumeSlider.value, 10) / 100;
      callerGain.gain.setTargetAtTime(sliderPct * callerAmp, audioCtx.currentTime, 0.01);
    }
  });
})();

/* ── Browser support check ──────────────────────────────────────────────────
 * Disables the start button and alerts the user if getDisplayMedia is absent.
 */
if (!navigator.mediaDevices?.getDisplayMedia) {
  setStatus('ERROR — Browser not supported', '');
  btnStart.disabled = true;
  alert('Your browser does not support screen capture.\nPlease use Chrome, Edge, or Firefox.');
}

/* ── initDevices ────────────────────────────────────────────────────────────
 * Boots device enumeration, source mode buttons, and loopback UI (devices.js).
 */
initDevices();

/* ── stopRecording ──────────────────────────────────────────────────────────
 * Stops MediaRecorder, releases all media streams, tears down audio pipeline,
 * clears timer and preview, resets UI to idle state.
 */
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

/* ── START ──────────────────────────────────────────────────────────────────
 * Delegates all stream capture to sources.js captureForMode().
 * Each mode is fully isolated — changing one never affects another.
 * Steps here: capture → audio pipeline → combine → MediaRecorder → go.
 */
btnStart.addEventListener('click', async () => {
  try {
    setStatus('CAPTURING…', '');

    const mode = getActiveMode();

    // ── Step 1: Capture streams via isolated mode function (sources.js) ──
    const {
      screenStream:       capturedScreen,
      micStream:          capturedMic,
      loopbackStream:     capturedLoopback,
      callerAudioStream,
      statusLabel,
    } = await captureForMode(mode);

    // Store globally for stopRecording() cleanup
    screenStream   = capturedScreen;
    micStream      = capturedMic;
    loopbackStream = capturedLoopback;

    // ── Step 2: Build audio pipeline ──
    const hasAnyAudio        = capturedMic || callerAudioStream;
    let processedAudioStream = null;
    if (hasAnyAudio) {
      processedAudioStream = buildAudioPipeline(capturedMic, callerAudioStream);
    }

    // ── Step 3: Combine video + processed audio into final MediaStream ──
    const chosenFormat = getChosenFormat();
    const videoTrack   = (chosenFormat !== 'mp3' && screenStream)
      ? screenStream.getVideoTracks()[0] : null;
    const allTracks    = [videoTrack].filter(Boolean);
    if (processedAudioStream) {
      processedAudioStream.getAudioTracks().forEach(t => allTracks.push(t));
    }
    const combined = new MediaStream(allTracks);

    // ── Step 4: Show live preview ──
    const previewStream = screenStream
      ? new MediaStream([...screenStream.getVideoTracks(), ...combined.getAudioTracks()])
      : combined;
    previewVideo.srcObject = previewStream;
    previewVideo.classList.add('active');
    previewPh.classList.add('hidden');
    previewVideo.play().catch(() => {});

    // ── Step 5: Determine mimeType and start MediaRecorder ──
    let mimeType;
    if (chosenFormat === 'mp3') {
      mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    } else {
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
    mediaRecorder.onstop = () => {
      saveRecording(chosenFormat, mimeType, recordedChunks, elapsedSeconds);
    };
    mediaRecorder.start(500);

    // Auto-stop when user ends screen share via browser UI
    if (videoTrack) {
      videoTrack.onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      };
    }

    isPaused = false;
    startTimer();
    recBadge.classList.add('visible');
    recTimer.classList.add('visible');
    setStatus(`RECORDING · ${statusLabel}`, 'recording');

    btnStart.disabled    = true;
    btnStop.disabled     = false;
    btnPause.disabled    = false;
    btnPause.textContent = 'PAUSE';

  } catch (err) {
    console.error('Capture error:', err);
    setStatus('ERROR — ' + err.message, '');
  }
});

/* ── PAUSE / RESUME ─────────────────────────────────────────────────────────
 * Toggles MediaRecorder between paused and active states.
 */
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

/* ── STOP ────────────────────────────────────────────────────────────────── */
btnStop.addEventListener('click', stopRecording);
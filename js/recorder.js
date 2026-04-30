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
// Mic path:     getUserMedia → GainNode (mic vol) → Analyser → Destination
// Caller path:  loopback/tab → GainNode (caller vol) → DynamicsCompressor → Analyser → Destination
//
// DynamicsCompressor on caller path prevents clipping and buzzing when
// caller volume is boosted high — compresses peaks before they distort.
function buildAudioPipeline(micStreamIn, callerStreamIn) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = audioCtx.createMediaStreamDestination();

  micGain    = audioCtx.createGain();
  callerGain = audioCtx.createGain();
  // Read current slider values at pipeline creation time
  micGain.gain.value    = parseInt(micVolumeSlider.value, 10) / 100;
  callerGain.gain.value = parseInt(callerVolumeSlider.value, 10) / 100;

  micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 256;
  sysAnalyser = audioCtx.createAnalyser(); sysAnalyser.fftSize = 256;

  // Compressor on caller path: prevents buzz/distortion at high gain
  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;  // start compressing at -24 dBFS
  compressor.knee.value      = 6;
  compressor.ratio.value     = 4;    // 4:1 compression ratio
  compressor.attack.value    = 0.003;
  compressor.release.value   = 0.25;

  if (micStreamIn && micStreamIn.getAudioTracks().length > 0) {
    const src = audioCtx.createMediaStreamSource(micStreamIn);
    src.connect(micGain);
    micGain.connect(micAnalyser);
    micGain.connect(dest);
  }

  if (callerStreamIn && callerStreamIn.getAudioTracks().length > 0) {
    const src = audioCtx.createMediaStreamSource(callerStreamIn);
    src.connect(callerGain);
    callerGain.connect(compressor);   // compress before measuring/recording
    compressor.connect(sysAnalyser);
    compressor.connect(dest);
  }

  // VU meter animation loop
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

    // Step 2: Capture microphone with noise processing ON
    const forceMic = (activeMode === 'screentabmic' || activeMode === 'camera');
    let micStreamLocal = null;
    if (forceMic || includeMic.checked) {
      try {
        micStreamLocal = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation:  true,
            noiseSuppression:  true,
            autoGainControl:   true
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
    const videoTrack = screenStream ? screenStream.getVideoTracks()[0] : null;
    const allTracks  = [videoTrack].filter(Boolean);
    if (processedAudioStream) {
      processedAudioStream.getAudioTracks().forEach(t => allTracks.push(t));
    }
    const combined = new MediaStream(allTracks);

    previewVideo.srcObject = combined;
    previewVideo.classList.add('active');
    previewPh.classList.add('hidden');

    // Step 7: Start MediaRecorder
    const mimeType = getBestWebM();
    const bitrate  = parseInt(qualitySelect.value, 10);
    recordedChunks = [];

    mediaRecorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 192000
    });

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => saveRecording(mimeType);
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

// ── SAVE ──────────────────────────────────────────────
function saveRecording(mimeType) {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `vcrec-${ts}.webm`;
  addToList(name, blob.size, url);
  triggerDownload(url, name);
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
}

function addToList(name, bytes, url) {
  const empty = recList.querySelector('.rec-empty');
  if (empty) empty.remove();
  const size = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  const dur  = formatTime(elapsedSeconds);
  const li   = document.createElement('li');
  li.className = 'rec-item';
  li.innerHTML = `
    <div class="rec-item-info">
      <span class="rec-item-name">${name}</span>
      <span class="rec-item-meta">${dur} · ${size} · WEBM</span>
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
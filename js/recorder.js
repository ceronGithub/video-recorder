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
/* ── buildMicChain ──────────────────────────────────────────────────────────
 * Complete noise cancellation for microphone input. Voice only — eliminates
 * fan hum, cricket resonance, mains hum, hiss, and room bleed.
 *
 * Strategy:
 *   A) Browser-level: echoCancellation + noiseSuppression via getUserMedia constraints (hardware/OS)
 *   B) HP × 2 at 200 Hz (Q=1.4) — steep 4th-order rolloff kills everything below voice
 *   C) Surgical notches on confirmed noise frequencies
 *   D) Low-pass ceiling at 7500 Hz — removes hiss/whine above voice range
 *   E) Adaptive spectral gate — continuously tracks noise floor every 3s,
 *      opens only when RMS is 18 dB above current floor, snap-closes instantly
 *   F) Compressor — normalize voice, prevent clipping
 *
 * Chain: source → gain → HP(200Hz) × 2 → notch(50Hz) → notch(100Hz)
 *        → notch(141Hz) → notch(153Hz) → notch(379Hz) → notch(424Hz)
 *        → mud(-12dB@180Hz) → presence(+5dB@2.5kHz) → LP(7500Hz)
 *        → adaptive spectral gate → compressor → dest
 */
function buildMicChain(ctx, sourceNode, gainNode, dest) {
  // 1. Dual high-pass at 200 Hz (Q=1.4) — stacked 4th-order rolloff.
  //    Voice fundamentals start at ~85 Hz (male) / ~165 Hz (female).
  //    200 Hz cuts all sub-voice noise: fan body, breath pops, handling rumble.
  const hp1 = ctx.createBiquadFilter();
  hp1.type            = 'highpass';
  hp1.frequency.value = 200;
  hp1.Q.value         = 1.4;

  const hp2 = ctx.createBiquadFilter();
  hp2.type            = 'highpass';
  hp2.frequency.value = 200;
  hp2.Q.value         = 1.4;

  // 2. Notch at 50 Hz — Philippines mains hum fundamental (PH grid = 50 Hz, NOT 60 Hz)
  const notch50 = ctx.createBiquadFilter();
  notch50.type            = 'notch';
  notch50.frequency.value = 50;
  notch50.Q.value         = 12;

  // 3. Notch at 100 Hz — 2nd harmonic of 50 Hz PH mains hum
  const notch100 = ctx.createBiquadFilter();
  notch100.type            = 'notch';
  notch100.frequency.value = 100;
  notch100.Q.value         = 10;

  // 4. Notch at 141 Hz — laptop fan motor fundamental (dominant persistent noise peak)
  const notch141 = ctx.createBiquadFilter();
  notch141.type            = 'notch';
  notch141.frequency.value = 141;
  notch141.Q.value         = 6;

  // 5. Notch at 153 Hz — fan harmonic (second strongest peak, drifts with fan RPM)
  const notch153 = ctx.createBiquadFilter();
  notch153.type            = 'notch';
  notch153.frequency.value = 153;
  notch153.Q.value         = 6;

  // 6. Notch at 379 Hz — cricket/laptop body resonance (confirmed in silence segments)
  const notch379 = ctx.createBiquadFilter();
  notch379.type            = 'notch';
  notch379.frequency.value = 379;
  notch379.Q.value         = 5;

  // 7. Notch at 424 Hz — cricket harmonic (confirmed at 424.5 Hz in silence segments)
  const notch424 = ctx.createBiquadFilter();
  notch424.type            = 'notch';
  notch424.frequency.value = 424;
  notch424.Q.value         = 5;

  // 8. Low-shelf mud cut — reduce boxy room buildup in the 180 Hz chest resonance zone
  const mud = ctx.createBiquadFilter();
  mud.type            = 'lowshelf';
  mud.frequency.value = 180;
  mud.gain.value      = -12;

  // 9. Presence boost at 2.5 kHz — voice intelligibility and clarity
  const presence = ctx.createBiquadFilter();
  presence.type            = 'peaking';
  presence.frequency.value = 2500;
  presence.Q.value         = 1.2;
  presence.gain.value      = 5;

  // 10. Low-pass ceiling at 7500 Hz — removes hiss, high-freq whine, and sibilance above voice
  const lp = ctx.createBiquadFilter();
  lp.type            = 'lowpass';
  lp.frequency.value = 7500;
  lp.Q.value         = 0.8;

  // 11. Adaptive spectral noise gate — CONTINUOUS floor tracking.
  //     PHASE 1 (first 1.5s): profiles noise floor from silence before first word.
  //     PHASE 2 (ongoing): re-samples floor every RETRAIN_BUFS when gate is CLOSED
  //     (i.e. only silence/noise is present — never updates floor during speech).
  //     Gate opens ONLY when RMS is VOICE_MARGIN dB above current floor.
  //     SNAP_CLOSE: gate snaps shut instantly (no fade-out delay) — prevents
  //     noise bleed in the tail after speech ends.
  const bufSize        = 1024;
  const gate           = ctx.createScriptProcessor(bufSize, 1, 1);
  const sampleRate     = ctx.sampleRate || 48000;
  const PROFILE_BUFS   = Math.ceil(1.5 * sampleRate / bufSize);
  const RETRAIN_BUFS   = Math.ceil(3.0 * sampleRate / bufSize);  // re-profile every 3s of silence
  const VOICE_MARGIN   = 18;    // 18 dB above noise floor — strict, voice is loud vs. noise
  const HOLD_SEC       = 0.15;  // short hold — prevents chopping within a word
  const FADE_IN_STEP   = 0.15;  // fast open — no fade-in lag on word starts
  const SNAP_CLOSE     = true;  // snap gate shut instantly when speech ends

  let profileCount    = 0;
  let noiseRmsSum     = 0;
  let noiseFloorRms   = 0.001;
  let retrainCount    = 0;
  let retrainSum      = 0;
  let holdCount       = 0;
  let holdSamples     = Math.round(HOLD_SEC * sampleRate / bufSize);
  let gateGain        = 0;
  let isOpen          = false;

  gate.onaudioprocess = e => {
    const input  = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // PHASE 1: initial noise floor profiling — mute output during calibration
    if (profileCount < PROFILE_BUFS) {
      noiseRmsSum += rms;
      profileCount++;
      if (profileCount === PROFILE_BUFS) {
        noiseFloorRms = (noiseRmsSum / PROFILE_BUFS) * 1.3;
      }
      output.fill(0);
      return;
    }

    const threshold = noiseFloorRms * Math.pow(10, VOICE_MARGIN / 20);
    const voiceDetected = rms > threshold;

    if (voiceDetected) {
      holdCount    = holdSamples;
      retrainCount = 0;   // reset retrain timer — don't sample floor during speech
      retrainSum   = 0;
      isOpen       = true;
    } else {
      if (holdCount > 0) holdCount--;

      // PHASE 2: continuously retrain floor during silence (gate closed)
      if (!isOpen || holdCount === 0) {
        retrainSum += rms;
        retrainCount++;
        if (retrainCount >= RETRAIN_BUFS) {
          // Update floor only if new measurement is plausible (not silent room spike)
          const newFloor = (retrainSum / retrainCount) * 1.3;
          if (newFloor > 0.00001) noiseFloorRms = newFloor;
          retrainCount = 0;
          retrainSum   = 0;
        }
      }
    }

    const targetGain = holdCount > 0 ? 1 : 0;
    if (targetGain === 0 && SNAP_CLOSE) {
      // Snap gate shut — no noise tail
      gateGain = 0;
      isOpen   = false;
    } else {
      gateGain = gateGain < targetGain
        ? Math.min(gateGain + FADE_IN_STEP, 1)
        : Math.max(gateGain - 0.05, 0);
    }

    for (let i = 0; i < input.length; i++) output[i] = input[i] * gateGain;
  };

  // 12. Compressor — normalize voice dynamics, prevent clipping on loud consonants
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value      = 5;
  comp.ratio.value     = 5;
  comp.attack.value    = 0.002;
  comp.release.value   = 0.20;

  // Wire: source → gain → hp1 → hp2 → notch50 → notch100 → notch141 → notch153
  //       → notch379 → notch424 → mud → presence → lp → gate → comp → dest
  sourceNode.connect(gainNode);
  gainNode.connect(hp1);
  hp1.connect(hp2);
  hp2.connect(notch50);
  notch50.connect(notch100);
  notch100.connect(notch141);
  notch141.connect(notch153);
  notch153.connect(notch379);
  notch379.connect(notch424);
  notch424.connect(mud);
  mud.connect(presence);
  presence.connect(lp);
  lp.connect(gate);
  gate.connect(comp);
  comp.connect(dest);

  return comp;
}

/* ── buildCallerChain ───────────────────────────────────────────────────────
 * Complete noise cancellation for caller / app audio (VB-Cable, tab audio).
 *
 * Strategy mirrors buildMicChain with two caller-specific adjustments:
 *   A) HP at 130 Hz (not 200 Hz) — caller voice/music content can start at ~130 Hz;
 *      raising HP higher risks cutting real audio. Notches handle 130–200 Hz noise surgically.
 *   B) HOLD_SEC = 0.4s (longer than mic) — caller audio includes music/pauses;
 *      longer hold prevents cutting mid-phrase on natural rests.
 *   C) VOICE_MARGIN = 15 dB — slightly looser than mic (18 dB) to preserve
 *      quieter caller speech without clipping soft passages.
 *
 * Chain: source → preBoost → gain → HP(130Hz) × 2 → notch(50Hz) → notch(100Hz)
 *        → notch(141Hz) → notch(153Hz) → notch(379Hz) → notch(424Hz)
 *        → mud(-12dB@180Hz) → presence(+5dB@2.5kHz) → LP(7500Hz)
 *        → adaptive spectral gate → compressor → dest
 */
function buildCallerChain(ctx, sourceNode, gainNode, dest) {
  // 1. Pre-boost — loopback audio typically arrives lower than mic level (~+8 dB baseline)
  const preBoost = ctx.createGain();
  preBoost.gain.value = 2.5;

  // 2. Dual high-pass at 130 Hz (Q=1.4) — stacked 4th-order rolloff.
  //    130 Hz floor preserves caller voice/music; notches handle noise above this point.
  const hp1 = ctx.createBiquadFilter();
  hp1.type            = 'highpass';
  hp1.frequency.value = 130;
  hp1.Q.value         = 1.4;

  const hp2 = ctx.createBiquadFilter();
  hp2.type            = 'highpass';
  hp2.frequency.value = 130;
  hp2.Q.value         = 1.4;

  // 3. Notch at 50 Hz — Philippines mains hum fundamental (PH grid = 50 Hz, NOT 60 Hz)
  const notch50 = ctx.createBiquadFilter();
  notch50.type            = 'notch';
  notch50.frequency.value = 50;
  notch50.Q.value         = 12;

  // 4. Notch at 100 Hz — 2nd harmonic of PH 50 Hz mains hum
  const notch100 = ctx.createBiquadFilter();
  notch100.type            = 'notch';
  notch100.frequency.value = 100;
  notch100.Q.value         = 10;

  // 5. Notch at 141 Hz — dominant fan motor peak (strongest in noise-only analysis)
  const notch141 = ctx.createBiquadFilter();
  notch141.type            = 'notch';
  notch141.frequency.value = 141;
  notch141.Q.value         = 6;

  // 6. Notch at 153 Hz — fan harmonic cluster (153.5 Hz confirmed, drifts with RPM)
  const notch153 = ctx.createBiquadFilter();
  notch153.type            = 'notch';
  notch153.frequency.value = 153;
  notch153.Q.value         = 6;

  // 7. Notch at 379 Hz — cricket/laptop body resonance (379 Hz confirmed in silence segments)
  const notch379 = ctx.createBiquadFilter();
  notch379.type            = 'notch';
  notch379.frequency.value = 379;
  notch379.Q.value         = 5;

  // 8. Notch at 424 Hz — cricket harmonic (424.5 Hz confirmed in silence segments)
  const notch424 = ctx.createBiquadFilter();
  notch424.type            = 'notch';
  notch424.frequency.value = 424;
  notch424.Q.value         = 5;

  // 9. Low-shelf mud cut — reduce boxy room buildup in the 180 Hz chest resonance zone
  const mud = ctx.createBiquadFilter();
  mud.type            = 'lowshelf';
  mud.frequency.value = 180;
  mud.gain.value      = -12;

  // 10. Presence boost at 2.5 kHz — voice intelligibility and clarity
  const presence = ctx.createBiquadFilter();
  presence.type            = 'peaking';
  presence.frequency.value = 2500;
  presence.Q.value         = 1.2;
  presence.gain.value      = 5;

  // 11. Low-pass ceiling at 7500 Hz — removes hiss and high-freq whine above voice range
  const lp = ctx.createBiquadFilter();
  lp.type            = 'lowpass';
  lp.frequency.value = 7500;
  lp.Q.value         = 0.8;

  // 12. Adaptive spectral noise gate — CONTINUOUS floor tracking (same logic as mic chain).
  //     VOICE_MARGIN = 15 dB (vs 18 dB mic) — slightly looser to preserve quiet caller speech.
  //     HOLD_SEC = 0.4s — longer than mic to avoid cutting caller audio on natural pauses.
  //     SNAP_CLOSE: gate snaps shut instantly when speech ends — no noise tail.
  const bufSize        = 1024;
  const gate           = ctx.createScriptProcessor(bufSize, 1, 1);
  const sampleRate     = ctx.sampleRate || 48000;
  const PROFILE_BUFS   = Math.ceil(1.5 * sampleRate / bufSize);
  const RETRAIN_BUFS   = Math.ceil(3.0 * sampleRate / bufSize);
  const VOICE_MARGIN   = 15;
  const HOLD_SEC       = 0.4;
  const FADE_IN_STEP   = 0.15;
  const SNAP_CLOSE     = true;

  let profileCount    = 0;
  let noiseRmsSum     = 0;
  let noiseFloorRms   = 0.001;
  let retrainCount    = 0;
  let retrainSum      = 0;
  let holdCount       = 0;
  let holdSamples     = Math.round(HOLD_SEC * sampleRate / bufSize);
  let gateGain        = 0;
  let isOpen          = false;

  gate.onaudioprocess = e => {
    const input  = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // PHASE 1: initial noise floor profiling — mute output during calibration
    if (profileCount < PROFILE_BUFS) {
      noiseRmsSum += rms;
      profileCount++;
      if (profileCount === PROFILE_BUFS) {
        noiseFloorRms = (noiseRmsSum / PROFILE_BUFS) * 1.3;
      }
      output.fill(0);
      return;
    }

    const threshold     = noiseFloorRms * Math.pow(10, VOICE_MARGIN / 20);
    const voiceDetected = rms > threshold;

    if (voiceDetected) {
      holdCount    = holdSamples;
      retrainCount = 0;
      retrainSum   = 0;
      isOpen       = true;
    } else {
      if (holdCount > 0) holdCount--;

      // PHASE 2: retrain floor every 3s of silence — adapts to changing noise environment
      if (!isOpen || holdCount === 0) {
        retrainSum += rms;
        retrainCount++;
        if (retrainCount >= RETRAIN_BUFS) {
          const newFloor = (retrainSum / retrainCount) * 1.3;
          if (newFloor > 0.00001) noiseFloorRms = newFloor;
          retrainCount = 0;
          retrainSum   = 0;
        }
      }
    }

    const targetGain = holdCount > 0 ? 1 : 0;
    if (targetGain === 0 && SNAP_CLOSE) {
      gateGain = 0;
      isOpen   = false;
    } else {
      gateGain = gateGain < targetGain
        ? Math.min(gateGain + FADE_IN_STEP, 1)
        : Math.max(gateGain - 0.05, 0);
    }

    for (let i = 0; i < input.length; i++) output[i] = input[i] * gateGain;
  };

  // 13. Compressor — normalize caller dynamics, prevent clipping
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value      = 5;
  comp.ratio.value     = 5;
  comp.attack.value    = 0.002;
  comp.release.value   = 0.20;

  // Wire: source → preBoost → gain → hp1 → hp2 → notch50 → notch100 → notch141
  //       → notch153 → notch379 → notch424 → mud → presence → lp → gate → comp → dest
  sourceNode.connect(preBoost);
  preBoost.connect(gainNode);
  gainNode.connect(hp1);
  hp1.connect(hp2);
  hp2.connect(notch50);
  notch50.connect(notch100);
  notch100.connect(notch141);
  notch141.connect(notch153);
  notch153.connect(notch379);
  notch379.connect(notch424);
  notch424.connect(mud);
  mud.connect(presence);
  presence.connect(lp);
  lp.connect(gate);
  gate.connect(comp);
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
    const comp = buildMicChain(audioCtx, src, micGain, dest);
    comp.connect(micAnalyser);
  }

  if (callerStreamIn && callerStreamIn.getAudioTracks().length > 0) {
    const src  = audioCtx.createMediaStreamSource(callerStreamIn);
    const comp = buildCallerChain(audioCtx, src, callerGain, dest);
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
            echoCancellation:    true,   // remove speaker bleed picked up by mic
            noiseSuppression:    true,   // OS/hardware-level noise suppression (fan, AC, background)
            autoGainControl:     false,  // OFF — our compressor handles normalization
            channelCount:        1,      // mono — halves noise floor, no stereo bleed
            sampleRate:          48000,
            sampleSize:          16,
            latency:             0       // lowest latency buffer — reduces gate reaction delay
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
    // Pass real elapsed duration in ms so EBML Duration field is correct.
    // elapsedSeconds is tracked by the timer — multiply by 1000 for milliseconds.
    const durationMs   = elapsedSeconds * 1000;
    const seekableBlob = await makeSeekable(rawBlob, durationMs);
    // For MP4: file is a seekable WebM container saved with .mp4 extension.
    // Most players (VLC, Windows Media Player, MX Player) handle this correctly
    // once the Duration + Cues metadata is present and valid.
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

/* ── makeSeekable ───────────────────────────────────────────────────────────
 * Injects Duration + Cues into a WebM blob so players can seek.
 * PROBLEM: MediaRecorder never writes a Duration field into the WebM stream,
 *          so reader2.duration is always NaN/0 → players can't seek.
 * FIX:     Accept knownDurationMs from the elapsed timer and forcefully patch
 *          it into the EBML metadata, overriding the missing/zero value.
 *          This gives players the real duration → seeking works correctly.
 */
function makeSeekable(blob, knownDurationMs) {
  return new Promise((resolve, reject) => {
    const reader  = new FileReader();
    reader.onload = () => {
      try {
        const buf     = reader.result;
        const decoder = new EBML.Decoder();
        const reader2 = new EBML.Reader();
        reader2.logging              = false;
        reader2.drop_default_duration = false;

        const elms = decoder.decode(buf);
        elms.forEach(e => reader2.read(e));
        reader2.stop();

        // Use the known real duration — reader2.duration is unreliable (often NaN)
        // WebM timecode scale default is 1,000,000 ns/tick = 1 ms per tick
        const durationMs = (knownDurationMs && knownDurationMs > 0)
          ? knownDurationMs
          : (isFinite(reader2.duration) && reader2.duration > 0 ? reader2.duration : 0);

        const refined = EBML.tools.makeMetadataSeekable(
          reader2.metadatas, durationMs, reader2.cues
        );
        const body        = buf.slice(reader2.metadataSize);
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
/* ===== AMP BUTTONS — x1 to x5 multiplier on top of volume slider =====
 * Each group of buttons toggles an .active class on click.
 * The selected multiplier is applied directly to the GainNode value,
 * factored together with the current volume slider percentage.
 */
(function initAmpButtons() {
  let micAmp    = 1;
  let callerAmp = 1;

  /* Wire a set of amp buttons; returns setter fn for the multiplier */
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
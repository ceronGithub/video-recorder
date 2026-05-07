/* ── audio.js ────────────────────────────────────────────────────────────────
 * Audio pipeline module.
 * Exports: buildAudioPipeline(), teardownAudio()
 * Owns: AudioContext, GainNodes, Analysers, VU meter animation.
 *
 * MIC chain:    source → gain → HP(200Hz)×2 → notch(50,100,141,153,379,424Hz)
 *               → mud(-12dB@180Hz) → presence(+5dB@2.5kHz) → LP(7500Hz)
 *               → adaptive spectral gate → compressor → dest
 *
 * CALLER chain: source → preBoost → gain → HP(130Hz)×2 → same notches
 *               → mud → presence → LP → compressor → dest
 *               NOTE: Caller chain receives ONLY clean loopback (VB-Cable/Stereo Mix).
 *               Application Window mode passes audio:false to getDisplayMedia so that
 *               system audio bleed (laptop fan noise) can never reach this chain.
 *               No noise gate on caller chain — loopback is a continuous stream;
 *               a gate would profile caller speech as the noise floor and silence it.
 */

'use strict';

/* ── Module state ────────────────────────────────────────────────────────── */
let audioCtx    = null;
let micGain     = null;
let callerGain  = null;
let micAnalyser = null;
let sysAnalyser = null;
let animFrame   = null;

/* ── buildMicChain ──────────────────────────────────────────────────────────
 * Complete noise cancellation for microphone input. Voice only — eliminates
 * fan hum, cricket resonance, mains hum, hiss, and room bleed.
 *
 * Strategy:
 *   A) Browser-level: echoCancellation + noiseSuppression via getUserMedia constraints
 *   B) HP × 2 at 200 Hz (Q=1.4) — steep 4th-order rolloff kills everything below voice
 *   C) Surgical notches on confirmed noise frequencies
 *   D) Low-pass ceiling at 7500 Hz — removes hiss/whine above voice range
 *   E) Adaptive spectral gate — continuously tracks noise floor every 3s,
 *      opens only when RMS is 18 dB above current floor, snap-closes instantly
 *   F) Compressor — normalize voice, prevent clipping
 */
function buildMicChain(ctx, sourceNode, gainNode, dest) {
  // 1. Dual high-pass at 200 Hz (Q=1.4) — stacked 4th-order rolloff
  const hp1 = ctx.createBiquadFilter();
  hp1.type = 'highpass'; hp1.frequency.value = 200; hp1.Q.value = 1.4;

  const hp2 = ctx.createBiquadFilter();
  hp2.type = 'highpass'; hp2.frequency.value = 200; hp2.Q.value = 1.4;

  // 2. Notch at 50 Hz — Philippines mains hum fundamental (PH grid = 50 Hz)
  const notch50 = ctx.createBiquadFilter();
  notch50.type = 'notch'; notch50.frequency.value = 50; notch50.Q.value = 12;

  // 3. Notch at 100 Hz — 2nd harmonic of 50 Hz PH mains hum
  const notch100 = ctx.createBiquadFilter();
  notch100.type = 'notch'; notch100.frequency.value = 100; notch100.Q.value = 10;

  // 4. Notch at 141 Hz — laptop fan motor fundamental
  const notch141 = ctx.createBiquadFilter();
  notch141.type = 'notch'; notch141.frequency.value = 141; notch141.Q.value = 6;

  // 5. Notch at 153 Hz — fan harmonic (drifts with fan RPM)
  const notch153 = ctx.createBiquadFilter();
  notch153.type = 'notch'; notch153.frequency.value = 153; notch153.Q.value = 6;

  // 6. Notch at 379 Hz — cricket/laptop body resonance
  const notch379 = ctx.createBiquadFilter();
  notch379.type = 'notch'; notch379.frequency.value = 379; notch379.Q.value = 5;

  // 7. Notch at 424 Hz — cricket harmonic (424.5 Hz confirmed)
  const notch424 = ctx.createBiquadFilter();
  notch424.type = 'notch'; notch424.frequency.value = 424; notch424.Q.value = 5;

  // 8. Low-shelf mud cut — reduce boxy 180 Hz chest resonance
  const mud = ctx.createBiquadFilter();
  mud.type = 'lowshelf'; mud.frequency.value = 180; mud.gain.value = -12;

  // 9. Presence boost at 2.5 kHz — voice intelligibility
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 2500;
  presence.Q.value = 1.2; presence.gain.value = 5;

  // 10. Low-pass ceiling at 7500 Hz — removes hiss above voice range
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 7500; lp.Q.value = 0.8;

  // 11. Adaptive spectral noise gate
  //     PHASE 1 (first 1.5s): profiles noise floor from silence.
  //     PHASE 2 (ongoing): re-samples floor every RETRAIN_BUFS when gate is closed.
  //     Gate opens ONLY when RMS is VOICE_MARGIN dB above current floor.
  //     SNAP_CLOSE: gate snaps shut instantly — prevents noise tail after speech.
  const bufSize      = 1024;
  const gate         = ctx.createScriptProcessor(bufSize, 1, 1);
  const sampleRate   = ctx.sampleRate || 48000;
  const PROFILE_BUFS = Math.ceil(1.5 * sampleRate / bufSize);
  const RETRAIN_BUFS = Math.ceil(3.0 * sampleRate / bufSize);
  const VOICE_MARGIN = 18;
  const HOLD_SEC     = 0.15;
  const FADE_IN_STEP = 0.15;
  const SNAP_CLOSE   = true;

  let profileCount  = 0;
  let noiseRmsSum   = 0;
  let noiseFloorRms = 0.001;
  let retrainCount  = 0;
  let retrainSum    = 0;
  let holdCount     = 0;
  let holdSamples   = Math.round(HOLD_SEC * sampleRate / bufSize);
  let gateGain      = 0;
  let isOpen        = false;

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
      if (profileCount === PROFILE_BUFS) noiseFloorRms = (noiseRmsSum / PROFILE_BUFS) * 1.3;
      output.fill(0);
      return;
    }

    const threshold    = noiseFloorRms * Math.pow(10, VOICE_MARGIN / 20);
    const voiceDetected = rms > threshold;

    if (voiceDetected) {
      holdCount = holdSamples;
      retrainCount = 0;
      retrainSum   = 0;
      isOpen       = true;
    } else {
      if (holdCount > 0) holdCount--;
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

  // 12. Compressor — normalize voice dynamics, prevent clipping
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 5;
  comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.20;

  // Wire: source → gain → hp1 → hp2 → notch50 → notch100 → notch141 → notch153
  //       → notch379 → notch424 → mud → presence → lp → gate → comp → dest
  sourceNode.connect(gainNode);
  gainNode.connect(hp1); hp1.connect(hp2); hp2.connect(notch50);
  notch50.connect(notch100); notch100.connect(notch141); notch141.connect(notch153);
  notch153.connect(notch379); notch379.connect(notch424);
  notch424.connect(mud); mud.connect(presence); presence.connect(lp);
  lp.connect(gate); gate.connect(comp); comp.connect(dest);

  return comp;
}

/* ── buildCallerChain ───────────────────────────────────────────────────────
 * Audio processing for caller / loopback audio (VB-Cable, tab audio).
 * Mirrors buildMicChain with caller-specific adjustments:
 *   A) HP at 130 Hz (not 200 Hz) — caller voice/music starts lower than mic
 *   B) NO noise gate — caller audio from VB-Cable arrives as a continuous stream.
 *      A gate profiles "silence" and then gates out the actual caller speech because
 *      it can't distinguish caller voice from noise floor at that level.
 *      The compressor handles dynamics instead.
 *   C) preBoost = 4.0 — loopback audio typically arrives 12-18dB quieter than mic
 *   D) Analyser tapped BEFORE compressor so VU meter shows real signal regardless of gain
 */
function buildCallerChain(ctx, sourceNode, gainNode, dest) {
  // 1. Pre-boost — loopback audio arrives significantly lower than mic
  const preBoost = ctx.createGain();
  preBoost.gain.value = 4.0;

  // 2. Dual high-pass at 130 Hz (Q=1.4) — preserves caller voice/music content
  const hp1 = ctx.createBiquadFilter();
  hp1.type = 'highpass'; hp1.frequency.value = 130; hp1.Q.value = 1.4;

  const hp2 = ctx.createBiquadFilter();
  hp2.type = 'highpass'; hp2.frequency.value = 130; hp2.Q.value = 1.4;

  // 3. Notch at 50 Hz — mains hum fundamental
  const notch50 = ctx.createBiquadFilter();
  notch50.type = 'notch'; notch50.frequency.value = 50; notch50.Q.value = 12;

  // 4. Notch at 100 Hz — 2nd harmonic
  const notch100 = ctx.createBiquadFilter();
  notch100.type = 'notch'; notch100.frequency.value = 100; notch100.Q.value = 10;

  // 5. Notch at 141 Hz — fan motor fundamental
  const notch141 = ctx.createBiquadFilter();
  notch141.type = 'notch'; notch141.frequency.value = 141; notch141.Q.value = 6;

  // 6. Notch at 153 Hz — fan harmonic
  const notch153 = ctx.createBiquadFilter();
  notch153.type = 'notch'; notch153.frequency.value = 153; notch153.Q.value = 6;

  // 7. Notch at 379 Hz — laptop body resonance
  const notch379 = ctx.createBiquadFilter();
  notch379.type = 'notch'; notch379.frequency.value = 379; notch379.Q.value = 5;

  // 8. Notch at 424 Hz — resonance harmonic
  const notch424 = ctx.createBiquadFilter();
  notch424.type = 'notch'; notch424.frequency.value = 424; notch424.Q.value = 5;

  // 9. Low-shelf mud cut
  const mud = ctx.createBiquadFilter();
  mud.type = 'lowshelf'; mud.frequency.value = 180; mud.gain.value = -12;

  // 10. Presence boost at 2.5 kHz — voice intelligibility
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 2500;
  presence.Q.value = 1.2; presence.gain.value = 5;

  // 11. Low-pass ceiling at 7500 Hz
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 7500; lp.Q.value = 0.8;

  // 12. Compressor — normalize caller dynamics without gating
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 5;
  comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.25;

  // Wire: source → preBoost → gain → hp1 → hp2 → notch50 → notch100 → notch141
  //       → notch153 → notch379 → notch424 → mud → presence → lp → comp → dest
  // NOTE: NO gate in this chain — gate was silencing all caller audio.
  sourceNode.connect(preBoost); preBoost.connect(gainNode);
  gainNode.connect(hp1); hp1.connect(hp2); hp2.connect(notch50);
  notch50.connect(notch100); notch100.connect(notch141); notch141.connect(notch153);
  notch153.connect(notch379); notch379.connect(notch424);
  notch424.connect(mud); mud.connect(presence); presence.connect(lp);
  lp.connect(comp); comp.connect(dest);

  return comp;
}

/* ── buildAudioPipeline ─────────────────────────────────────────────────────
 * Creates AudioContext, wires mic and caller chains, starts VU meter animation.
 * Returns the combined MediaStream with processed audio tracks.
 */
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
    micAnalyser.connect(audioCtx.destination); // tap after comp, before dest — meter reads processed signal
  }

  if (callerStreamIn && callerStreamIn.getAudioTracks().length > 0) {
    const src = audioCtx.createMediaStreamSource(callerStreamIn);

    // Tap analyser DIRECTLY on raw source — before all processing and gain.
    // This ensures the CALLER meter shows signal regardless of gain slider value,
    // confirming VB-Cable is actually delivering audio.
    src.connect(sysAnalyser);

    const comp = buildCallerChain(audioCtx, src, callerGain, dest);
  }

  // VU meter animation — draws real-time levels from analysers
  const buf = new Uint8Array(256);
  function draw() {
    animFrame = requestAnimationFrame(draw);
    micAnalyser.getByteFrequencyData(buf);
    micMeter.style.width = Math.min(buf.reduce((a, b) => a + b, 0) / buf.length * 2.5, 100) + '%';
    sysAnalyser.getByteFrequencyData(buf);
    sysMeter.style.width = Math.min(buf.reduce((a, b) => a + b, 0) / buf.length * 2.5, 100) + '%';
  }
  draw();

  return dest.stream;
}

/* ── teardownAudio ──────────────────────────────────────────────────────────
 * Cancels animation frame, resets VU meters, closes AudioContext, nulls refs.
 */
function teardownAudio() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  micMeter.style.width = '0%';
  sysMeter.style.width = '0%';
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  micGain = null; callerGain = null;
  micAnalyser = null; sysAnalyser = null;
}
/* ============================================================
   sources.js — Isolated capture functions per source mode.
   ============================================================
   ARCHITECTURE:
     Each mode is a self-contained async function that returns
     { screenStream, micStream, loopbackStream, callerAudioStream }.
     recorder.js calls only captureForMode(mode) — it never
     needs to know the internal details of any mode.

     Adding or changing one mode never touches another.

   MODE MAP:
     'screen'       → captureEntireScreen()
     'window'       → captureApplicationWindow()
     'screentabmic' → captureScreenTabMic()
     'camera'       → captureCameraAndMic()
     'interview'    → captureInterviewCall()   ← NEW (VB-Cable only)
   ============================================================ */

'use strict';

/* ── Shared mic constraints ─────────────────────────────────────────────────
 * Used by any mode that captures the user's microphone.
 * Centralised here so all modes stay in sync if constraints change.
 */
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  false,
    channelCount:     1,
    sampleRate:       48000,
    sampleSize:       16,
    latency:          0,
  },
  video: false,
};

/* ── Loopback constraints factory ───────────────────────────────────────────
 * Returns getUserMedia constraints for a specific loopback device ID.
 * Raw capture — no processing — so caller audio arrives unmodified.
 */
function loopbackConstraints(deviceId) {
  return {
    audio: {
      deviceId:         { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
    },
    video: false,
  };
}

/* ── safeMic ────────────────────────────────────────────────────────────────
 * WHAT: Attempts to capture the microphone. Returns null on failure instead
 *       of throwing — so a missing mic never crashes the session.
 * HOW:  Wraps getUserMedia in try/catch, logs warning on failure.
 * CALLED BY: all capture functions that include mic
 */
async function safeMic() {
  try {
    return await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (e) {
    console.warn('[sources] Mic unavailable:', e.message);
    return null;
  }
}

/* ── safeLoopback ───────────────────────────────────────────────────────────
 * WHAT: Attempts to capture a loopback device by ID. Returns null on failure.
 * HOW:  Wraps getUserMedia in try/catch, logs warning on failure.
 * CALLED BY: captureEntireScreen, captureApplicationWindow, captureInterviewCall
 */
async function safeLoopback(deviceId) {
  if (!deviceId) return null;
  try {
    return await navigator.mediaDevices.getUserMedia(loopbackConstraints(deviceId));
  } catch (e) {
    console.warn('[sources] Loopback device unavailable:', e.message);
    return null;
  }
}

/* ============================================================
   MODE 01 — ENTIRE SCREEN
   ============================================================
   WHAT: Captures the full monitor + system audio.
         Mic and loopback device are optional.
   HOW:  getDisplayMedia with displaySurface:'monitor'.
         Loopback device (VB-Cable) is preferred over tab audio
         as callerAudioStream.
   CALLED BY: captureForMode('screen')
   ============================================================ */
async function captureEntireScreen() {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor', cursor: 'always' },
    audio: { suppressLocalAudioPlayback: false },
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
  });

  const micStream      = includeMic.checked ? await safeMic() : null;
  const loopbackId     = callerDeviceSelect.value;
  const loopbackStream = await safeLoopback(loopbackId);

  // Loopback takes priority over tab/system audio as caller source
  const tabAudio          = displayStream.getAudioTracks().length > 0 ? displayStream : null;
  const callerAudioStream = loopbackStream || tabAudio;

  return {
    screenStream:       displayStream,
    micStream,
    loopbackStream,
    callerAudioStream,
    statusLabel:        loopbackStream ? 'LOOPBACK' : tabAudio ? 'SYSTEM AUDIO' : 'NO CALLER AUDIO',
  };
}

/* ============================================================
   MODE 02 — APPLICATION WINDOW
   ============================================================
   WHAT: Captures a single application window. No system audio
         (most browsers block it for window capture).
         Caller audio comes from loopback device if selected.
   HOW:  getDisplayMedia with displaySurface:'window'.
         Mic and loopback are optional.
   CALLED BY: captureForMode('window')
   ============================================================ */
async function captureApplicationWindow() {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'window', cursor: 'always' },
    audio: true,
    selfBrowserSurface: 'exclude',
  });

  const micStream      = includeMic.checked ? await safeMic() : null;
  const loopbackId     = callerDeviceSelect.value;
  const loopbackStream = await safeLoopback(loopbackId);

  const tabAudio          = displayStream.getAudioTracks().length > 0 ? displayStream : null;
  const callerAudioStream = loopbackStream || tabAudio;

  return {
    screenStream:       displayStream,
    micStream,
    loopbackStream,
    callerAudioStream,
    statusLabel:        loopbackStream ? 'LOOPBACK' : tabAudio ? 'WINDOW AUDIO' : 'NO CALLER AUDIO',
  };
}

/* ============================================================
   MODE 03 — SCREEN + TAB + MIC
   ============================================================
   WHAT: Captures a browser tab with its audio + the user's mic.
         Best mode for recording web-based calls (Meet, Messenger).
   HOW:  getDisplayMedia with displaySurface:'browser'.
         Mic is ALWAYS captured regardless of the mic toggle.
         Tab audio is the callerAudioStream — no loopback needed.
   CALLED BY: captureForMode('screentabmic')
   ============================================================ */
async function captureScreenTabMic() {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser', cursor: 'always' },
    audio: true,
    selfBrowserSurface: 'exclude',
  });

  // Mic is mandatory in this mode — user's voice must always be captured
  const micStream = await safeMic();

  const tabAudio          = displayStream.getAudioTracks().length > 0 ? displayStream : null;
  const callerAudioStream = tabAudio;

  return {
    screenStream:       displayStream,
    micStream,
    loopbackStream:     null,    // not used in this mode
    callerAudioStream,
    statusLabel:        tabAudio ? 'TAB AUDIO' : 'NO TAB AUDIO',
  };
}

/* ============================================================
   MODE 04 — CAMERA + MIC
   ============================================================
   WHAT: Captures the webcam video + user's microphone. No screen.
         For face-cam recordings, podcasts, or local video notes.
   HOW:  getUserMedia for camera (HD ideal) + separate mic capture.
         No caller audio — this mode has no remote participant.
   CALLED BY: captureForMode('camera')
   ============================================================ */
async function captureCameraAndMic() {
  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,   // mic captured separately for independent gain control
  });

  // Mic is always on in camera mode — no caller, only local voice
  const micStream = await safeMic();

  return {
    screenStream:       cameraStream,
    micStream,
    loopbackStream:     null,
    callerAudioStream:  null,    // no remote caller in camera mode
    statusLabel:        'CAMERA',
  };
}

/* ============================================================
   MODE 05 — INTERVIEW / CALL  (VB-Cable only)
   ============================================================
   WHAT: Audio-only mode for phone/VoIP interviews captured via
         VB-Cable loopback. No screen capture — just mic + loopback.
         Outputs as MP3 or audio-only WebM.
   HOW:  getUserMedia for mic + loopback device (required).
         No getDisplayMedia called — no video track produced.
         recorder.js will detect null screenStream and skip video.
   CALLED BY: captureForMode('interview')
   ============================================================ */
async function captureInterviewCall() {
  // Mic — user's voice
  const micStream = await safeMic();

  // Loopback — caller's voice via VB-Cable / Stereo Mix
  const loopbackId     = callerDeviceSelect.value;
  const loopbackStream = await safeLoopback(loopbackId);

  if (!loopbackStream) {
    console.warn('[sources] Interview/Call mode: no loopback device selected. Caller audio will be silent.');
  }

  return {
    screenStream:       null,           // no video in interview mode
    micStream,
    loopbackStream,
    callerAudioStream:  loopbackStream, // loopback IS the caller source
    statusLabel:        loopbackStream ? 'LOOPBACK · AUDIO ONLY' : 'MIC ONLY · NO CALLER',
  };
}

/* ============================================================
   captureForMode — public dispatcher
   ============================================================
   WHAT: Routes to the correct isolated capture function based on mode.
   HOW:  Simple switch — adding a new mode = adding a new case + function.
         Nothing else in recorder.js needs to change.
   CALLED BY: recorder.js btnStart click handler
   ============================================================ */
async function captureForMode(mode) {
  switch (mode) {
    case 'screen':       return captureEntireScreen();
    case 'window':       return captureApplicationWindow();
    case 'screentabmic': return captureScreenTabMic();
    case 'camera':       return captureCameraAndMic();
    case 'interview':    return captureInterviewCall();
    default:
      throw new Error(`[sources] Unknown mode: "${mode}"`);
  }
}

/* ============================================================
   sourceInfo.js — Source & Mic info modals.
   ============================================================
   WHAT: When a source button or the mic toggle label is clicked,
         opens an instructional modal explaining what that source
         captures, what it's best for, and its audio behavior.
         The modal is purely informational — it does NOT change
         the selected source; selection remains handled by recorder.js.

   HOW:  Reads data-mode from each .src-btn and maps it to a
         content definition object. Renders the modal, then closes
         it on overlay click, close button click, or Escape key.

         Mic toggle gets its own info icon that opens a mic-specific
         modal explaining internal-only audio capture behavior.

   DEPENDS ON: index.html modal markup (#sourceInfoModal),
               style.css modal styles.
   ============================================================ */

'use strict';

/* ── Content definitions per source mode ────────────────────────────────────
 * Each key matches a data-mode attribute on a .src-btn element.
 * icon    : emoji shown large in modal header
 * title   : modal heading
 * badge   : optional small tag (same text as src-tag)
 * bestFor : short string — what this mode is ideal for
 * apps    : array of app name strings shown as pill tags
 * howIt   : paragraph explaining capture behavior
 * audioNote: paragraph explaining exactly what audio is captured
 * tips    : array of tip strings
 */
const sourceModeInfo = {
  screen: {
    icon: '⬜',
    title: 'Entire Screen',
    badge: null,
    bestFor: 'General screen recording & desktop app calls with VB-Cable',
    apps: ['OBS Alternative', 'Desktop Recording', 'Teams (with VB-Cable)', 'Zoom (with VB-Cable)'],
    howIt: 'Captures your full monitor — every window, notification, and cursor movement is recorded. Best when you need to show the entire desktop or when the call app takes up the full screen.',
    audioNote: 'Audio captured: System audio from your entire PC (internal). This includes sounds from any application playing on your machine — music, call audio, notification sounds. It does NOT capture audio from your physical speakers or room — only what your computer is outputting internally. Your microphone is separate and mixed in alongside.',
    tips: [
      'For desktop call apps (Teams, Zoom, Skype), pair with VB-Cable loopback to capture caller voice cleanly.',
      'System audio is internal only — fan noise or room sound will NOT bleed in.',
      'Hide sensitive notifications before starting — the full screen is recorded.',
    ],
  },

  window: {
    icon: '⧉',
    title: 'Application Window',
    badge: null,
    bestFor: 'Recording a single desktop call app without capturing the rest of your screen',
    apps: ['Viber', 'WhatsApp Desktop', 'Skype', 'Facebook Messenger', 'Telegram Desktop', 'Signal Desktop'],
    howIt: 'Captures only the selected application window — nothing else on your desktop is visible. When the share dialog appears, choose the specific call app window you want to record. Perfect for privacy when other windows contain sensitive content.',
    audioNote: 'Audio captured: Caller voice via VB-Cable loopback only (internal). Window mode intentionally does NOT grab system audio through the browser — this prevents laptop fan noise and ambient hiss from leaking into the caller audio track. The only audio source is the clean loopback path (VB-Cable / Stereo Mix). Your microphone is captured separately and mixed in.',
    tips: [
      'VB-Cable is required to capture the caller\'s voice — select ★ CABLE Output in the Caller Audio Device row.',
      'Set CABLE Input as your Windows default playback device before starting the call.',
      'This is the recommended mode for Viber, WhatsApp, Skype, and Messenger desktop apps.',
      'The caller\'s side is captured clean — no fan noise, no ambient room bleed.',
    ],
  },

  screentabmic: {
    icon: '🎙',
    title: 'Screen + Tab + Mic',
    badge: 'CALL REC',
    bestFor: 'Browser-based video & voice calls — no extra software needed',
    apps: ['Facebook Messenger (web)', 'Google Meet', 'Microsoft Teams (web)', 'WhatsApp Web', 'Discord (browser)', 'Zoom (browser)'],
    howIt: 'Captures a single browser tab — its video and its audio — alongside your microphone. When the share dialog appears, switch to the "Chrome Tab" section and select the tab where your call is running. Enable "Share tab audio" in the dialog before clicking Share.',
    audioNote: 'Audio captured: Tab audio only (internal). This is the audio the browser tab is producing — the caller\'s voice, any video sound, notification sounds within that tab. It does NOT capture your speakers, your room, or other tabs. External microphone noise does not bleed into the tab audio channel. Your mic is captured as a separate, clean track.',
    tips: [
      'In the share dialog, click "Chrome Tab" — NOT "Window" or "Entire Screen".',
      'Always tick "Share tab audio" in the dialog or caller audio will be silent.',
      'Works for any web-based call — no VB-Cable or extra setup needed.',
      'Only the selected tab is recorded — other tabs and desktop apps stay private.',
    ],
  },

  camera: {
    icon: '◉',
    title: 'Camera + Mic',
    badge: null,
    bestFor: 'Face-cam recording, video diaries, podcasts, and local video notes',
    apps: ['Face-cam Recording', 'Video Diary', 'Podcast Recording', 'Local Video Notes', 'Webcam Test'],
    howIt: 'Captures your webcam video and your microphone audio. No screen or tab is recorded — only what your camera sees and what your mic hears. Ideal for recording yourself speaking to camera, conducting a solo podcast, or creating a video message.',
    audioNote: 'Audio captured: Your microphone only (external input to your PC, internal to the recording pipeline). This mode has no caller — there is no remote participant audio. What you speak into the mic is the only audio source. Room noise picked up by the mic will be captured, but the audio chain applies noise cancellation and suppression to reduce it.',
    tips: [
      'Ensure good lighting — face a window or use a ring light for best results.',
      'Position the mic close to your mouth for cleaner voice capture.',
      'No caller audio in this mode — it\'s a solo recording only.',
    ],
  },

  interview: {
    icon: '🎧',
    title: 'Interview / Call',
    badge: 'VB-CABLE',
    bestFor: 'Audio-only phone interviews, podcast calls, and VoIP recordings via VB-Cable',
    apps: ['Phone Call (via VoIP)', 'Radio Interview', 'Podcast Guest Call', 'Zoom Audio Only', 'Teams Audio Only'],
    howIt: 'Audio-only mode — no screen is recorded. Captures your microphone and the caller\'s voice via the VB-Cable loopback device. Outputs as MP3 or audio-only WebM. Designed for interviews and calls where video is unnecessary.',
    audioNote: 'Audio captured: Your microphone (your voice) + VB-Cable loopback (caller\'s voice) — both internal to the recording pipeline. No screen audio, no tab audio, no ambient room sound beyond what your mic picks up. The loopback path routes caller audio digitally — it is not re-recorded from speakers, so there is zero playback bleed or echo.',
    tips: [
      'VB-Cable is required — install it free from vb-audio.com/Cable.',
      'Set CABLE Input as your Windows default playback before starting the call.',
      'Select ★ CABLE Output in the Caller Audio Device row, then click Refresh ↻.',
      'Use MP3 output format for the smallest audio-only file size.',
    ],
  },
};

/* ── Mic toggle info content ────────────────────────────────────────────────
 * Shown when the user clicks the mic info icon next to the toggle.
 */
const micInfo = {
  icon: '🎤',
  title: 'Capture Microphone',
  howIt: 'When enabled, your physical microphone is captured as a separate audio track and mixed into the recording alongside any system or caller audio.',
  audioNote: 'What the mic captures: Only sound that physically enters your microphone — your voice, your room, nearby speakers. It does NOT capture internal computer audio (YouTube playback, call audio, notification sounds). Internal audio travels through a completely separate digital path and is captured via System Audio or VB-Cable loopback — not the mic. Enabling the mic toggle will NOT cause YouTube audio or caller audio to appear in the mic channel.',
  tips: [
    'Turn OFF the mic if you only want to record system/caller audio without your voice.',
    'The mic channel has noise cancellation and suppression applied automatically.',
    'To record YouTube audio: use Screen + Tab + Mic mode and select the YouTube tab — the mic is not involved in capturing that audio.',
    'Internal audio (apps, calls, video) and external audio (mic) are always separate tracks.',
  ],
};

/* ── DOM references ─────────────────────────────────────────────────────────
 * Resolved after DOMContentLoaded to avoid null references.
 */
let modalOverlay, modalIcon, modalTitle, modalBadge;
let modalBestFor, modalBestForRow, modalApps;
let modalHowIt, modalAudioNote, modalTipsList;
let modalCloseBtn;

/* ── openModal ──────────────────────────────────────────────────────────────
 * WHAT: Populates and shows the info modal with the given content object.
 * HOW:  Sets inner text/HTML for each modal slot, then removes .hidden.
 * CALLED BY: source button click handlers, mic info icon click handler.
 */
function openModal(content) {
  modalIcon.textContent      = content.icon;
  modalTitle.textContent     = content.title;

  // Badge — show only if defined
  if (content.badge) {
    modalBadge.textContent = content.badge;
    modalBadge.style.display = 'inline-block';
  } else {
    modalBadge.style.display = 'none';
  }

  // Best For row — hide if not present (mic modal)
  if (content.bestFor) {
    modalBestFor.textContent = content.bestFor;
    modalBestForRow.style.display = 'flex';
  } else {
    modalBestForRow.style.display = 'none';
  }

  // App pills — rebuild list
  modalApps.innerHTML = '';
  if (content.apps && content.apps.length) {
    content.apps.forEach(function(app) {
      const pill = document.createElement('span');
      pill.className = 'modalAppPill';
      pill.textContent = app;
      modalApps.appendChild(pill);
    });
    modalApps.parentElement.style.display = 'block';
  } else {
    modalApps.parentElement.style.display = 'none';
  }

  modalHowIt.textContent    = content.howIt;
  modalAudioNote.textContent = content.audioNote;

  // Tips list — rebuild
  modalTipsList.innerHTML = '';
  if (content.tips && content.tips.length) {
    content.tips.forEach(function(tip) {
      const li = document.createElement('li');
      li.textContent = tip;
      modalTipsList.appendChild(li);
    });
  }

  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

/* ── closeModal ─────────────────────────────────────────────────────────────
 * WHAT: Hides the modal and restores body scroll.
 * HOW:  Adds .hidden class back, restores overflow.
 * CALLED BY: close button, overlay click, Escape key.
 */
function closeModal() {
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

/* ── init ───────────────────────────────────────────────────────────────────
 * WHAT: Resolves DOM references, binds click handlers on all source buttons
 *       and on the mic info icon.
 * HOW:  querySelectorAll on .src-btn; reads data-mode to get content object.
 *       Escape key closes via document keydown listener.
 * CALLED BY: DOMContentLoaded
 */
function initSourceInfo() {
  // Resolve modal DOM slots
  modalOverlay     = document.getElementById('sourceInfoModal');
  modalIcon        = document.getElementById('modalIcon');
  modalTitle       = document.getElementById('modalTitle');
  modalBadge       = document.getElementById('modalBadge');
  modalBestFor     = document.getElementById('modalBestFor');
  modalBestForRow  = document.getElementById('modalBestForRow');
  modalApps        = document.getElementById('modalApps');
  modalHowIt       = document.getElementById('modalHowIt');
  modalAudioNote   = document.getElementById('modalAudioNote');
  modalTipsList    = document.getElementById('modalTipsList');
  modalCloseBtn    = document.getElementById('modalCloseBtn');

  // Source buttons — open modal on click, then allow selection to propagate
  document.querySelectorAll('.src-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const mode    = btn.getAttribute('data-mode');
      const content = sourceModeInfo[mode];
      if (content) openModal(content);
    });
  });

  // Mic info icon — open mic modal
  const micInfoIcon = document.getElementById('micInfoIcon');
  if (micInfoIcon) {
    micInfoIcon.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      openModal(micInfo);
    });
  }

  // Close button
  modalCloseBtn.addEventListener('click', closeModal);

  // Overlay background click closes modal
  modalOverlay.addEventListener('click', function(e) {
    if (e.target === modalOverlay) closeModal();
  });

  // Escape key closes modal
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
  });
}

document.addEventListener('DOMContentLoaded', initSourceInfo);

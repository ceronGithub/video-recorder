/* ── devices.js ──────────────────────────────────────────────────────────────
 * Device management module.
 * Handles: loopback device dropdown population, source mode selection,
 *          loopback UI visibility, loopback warning display.
 */

'use strict';

/* ── State ───────────────────────────────────────────────────────────────── */
let activeMode = 'screen';

/* ── populateDevices ────────────────────────────────────────────────────────
 * Enumerates all audioinput devices and populates the caller device dropdown.
 * Triggers mic permission so device labels are visible (not blank).
 * Stars known loopback devices (VB-Cable, Stereo Mix) for easy identification.
 */
async function populateDevices() {
  try {
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

/* ── updateLoopbackUI ───────────────────────────────────────────────────────
 * Shows or hides the loopback device row based on the active source mode.
 * Loopback is only relevant for screen and window modes (desktop apps).
 */
function updateLoopbackUI() {
  const needsLoopback = (activeMode === 'screen' || activeMode === 'window');
  callerDeviceRow.style.display = needsLoopback ? 'flex' : 'none';
  updateLoopbackWarning();
}

/* ── updateLoopbackWarning ──────────────────────────────────────────────────
 * Warns the user that desktop apps (Teams, Zoom) require a loopback device.
 * Warning shows only when screen/window mode is active AND no device is chosen.
 */
function updateLoopbackWarning() {
  if (!loopbackWarning) return;
  const needsLoopback = (activeMode === 'screen' || activeMode === 'window');
  const hasDevice     = callerDeviceSelect.value !== '';
  loopbackWarning.style.display = (needsLoopback && !hasDevice) ? 'block' : 'none';
}

/* ── getActiveMode ──────────────────────────────────────────────────────────
 * Returns the currently selected source mode string.
 */
function getActiveMode() { return activeMode; }

/* ── initDevices ────────────────────────────────────────────────────────────
 * Wires all device-related event listeners and performs initial device load.
 */
function initDevices() {
  populateDevices();
  btnRefreshDevices.addEventListener('click', populateDevices);
  callerDeviceSelect.addEventListener('change', updateLoopbackWarning);

  // Source mode buttons — toggle active class and update loopback UI
  srcBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      srcBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMode = btn.dataset.mode;
      updateLoopbackUI();
    });
  });

  updateLoopbackUI();
}

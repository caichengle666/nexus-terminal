'use strict';

// Hardware acceleration ("GPU") mode for the desktop app.
//
// Setting `hardwareAcceleration`: 'auto' (default) | 'on' | 'off'.
// In 'auto' the GPU is used unless a fallback was recorded for this app/Electron
// version. A fallback is recorded when the GPU process keeps crashing, when GPU
// launches never reach a rendered UI (startup sentinel), or when the rendered
// window captures as one uniform colour (blank window). The pure decision logic
// lives here so it can be unit tested; main.js only wires it to Electron.

const fs = require('fs');
const path = require('path');

const HARDWARE_ACCELERATION_MODES = ['auto', 'on', 'off'];
const SETTINGS_FILE = 'gpu-settings.json';
const PENDING_MARKER_FILE = 'gpu-launch-pending';
const UNCONFIRMED_LAUNCH_LIMIT = 2;
const EARLY_CRASH_WINDOW_MS = 60 * 1000;
const GPU_CRASH_LIMIT = 2;

/** Strict validation: only the three exact strings are accepted. */
const normalizeMode = value => (typeof value === 'string' && HARDWARE_ACCELERATION_MODES.includes(value) ? value : null);

/** Manual escape hatches: `--disable-gpu`, `--disable-hardware-acceleration`, NEXUS_DISABLE_GPU=1. */
const readForceDisable = (argv = [], env = {}) => {
  if (argv.includes('--disable-hardware-acceleration') || argv.includes('--disable-gpu')) return 'cli-flag';
  if (['1', 'true', 'yes'].includes(String(env.NEXUS_DISABLE_GPU || '').trim().toLowerCase())) return 'env';
  return null;
};

/** Settings file contents → a clean state object (garbage in, defaults out). */
const sanitizeState = raw => {
  const value = raw && typeof raw === 'object' ? raw : {};
  const fallback = value.fallback && typeof value.fallback === 'object' && value.fallback.fallback === true
    ? {
      fallback: true,
      reason: String(value.fallback.reason || 'unknown').slice(0, 64),
      appVersion: String(value.fallback.appVersion || ''),
      electronVersion: String(value.fallback.electronVersion || ''),
      at: String(value.fallback.at || ''),
    }
    : null;
  const unconfirmed = Number.isInteger(value.unconfirmedLaunches) && value.unconfirmedLaunches > 0 ? value.unconfirmedLaunches : 0;
  return {
    hardwareAcceleration: normalizeMode(value.hardwareAcceleration) || 'auto',
    fallback,
    unconfirmedLaunches: Math.min(unconfirmed, 99),
  };
};

const makeFallback = (reason, versions, now) => ({
  fallback: true,
  reason,
  appVersion: versions.appVersion,
  electronVersion: versions.electronVersion,
  at: new Date(now).toISOString(),
});

/**
 * Applies what is known at launch to the persisted state:
 * - a fallback recorded for another app/Electron version is cleared once (retry GPU after an update);
 * - an uncleared pending marker means the previous GPU launch never confirmed a rendered UI:
 *   count it, run this launch in software, and record a fallback after UNCONFIRMED_LAUNCH_LIMIT in a row.
 * Returns { state, changed, softwareThisLaunch }.
 */
const applyLaunchState = (inputState, { pendingMarkerFound, appVersion, electronVersion, now = Date.now() }) => {
  const state = { ...sanitizeState(inputState) };
  let changed = false;
  let softwareThisLaunch = false;
  if (state.fallback && (state.fallback.appVersion !== appVersion || state.fallback.electronVersion !== electronVersion)) {
    state.fallback = null;
    state.unconfirmedLaunches = 0;
    changed = true;
  }
  if (pendingMarkerFound) {
    state.unconfirmedLaunches += 1;
    softwareThisLaunch = true;
    if (state.unconfirmedLaunches >= UNCONFIRMED_LAUNCH_LIMIT && !state.fallback) {
      state.fallback = makeFallback('startup-unconfirmed', { appVersion, electronVersion }, now);
    }
    changed = true;
  }
  return { state, changed, softwareThisLaunch };
};

/**
 * decide(settings, platform, flags, state) → { useGpu, reason }
 * settings: { hardwareAcceleration }, flags: { forceDisable: 'cli-flag' | 'env' | null },
 * state: { fallback, softwareThisLaunch }. `platform` is accepted for future per-platform rules;
 * today every platform starts with the GPU enabled.
 */
const decide = (settings = {}, _platform = process.platform, flags = {}, state = {}) => {
  if (flags.forceDisable) return { useGpu: false, reason: flags.forceDisable };
  const mode = normalizeMode(settings.hardwareAcceleration) || 'auto';
  if (mode === 'off') return { useGpu: false, reason: 'setting-off' };
  if (mode === 'on') return { useGpu: true, reason: 'setting-on' };
  if (state.fallback) return { useGpu: false, reason: `fallback:${state.fallback.reason || 'unknown'}` };
  if (state.softwareThisLaunch) return { useGpu: false, reason: 'unconfirmed-launch' };
  return { useGpu: true, reason: 'auto' };
};

/** A GPU child-process-gone event that should count as a crash. */
const isGpuCrash = details => Boolean(details && details.type === 'GPU' && !['clean-exit', 'killed'].includes(details.reason));

/** Fallback after GPU_CRASH_LIMIT crashes, or after one crash in the first minute. */
const shouldFallbackOnGpuCrash = ({ crashCount, msSinceStart }) => crashCount >= GPU_CRASH_LIMIT
  || (crashCount >= 1 && msSinceStart <= EARLY_CRASH_WINDOW_MS);

/**
 * True when a BGRA/RGBA bitmap is essentially one colour (max channel standard deviation < threshold).
 * Uniformity, not whiteness: a light theme is fine as long as there is any content.
 */
const isUniformBitmap = (bitmap, { threshold = 1.5, step = 4 } = {}) => {
  if (!bitmap || bitmap.length < 4 * 16) return false;
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  let count = 0;
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * step) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = bitmap[offset + channel];
      sums[channel] += value;
      squares[channel] += value * value;
    }
    count += 1;
  }
  if (count < 16) return false;
  return sums.every((sum, channel) => {
    const mean = sum / count;
    const variance = Math.max(0, squares[channel] / count - mean * mean);
    return Math.sqrt(variance) < threshold;
  });
};

/** userData can be redirected next to the exe in portable mode; this must work before app ready. */
const resolveDataDir = ({ exeDir, defaultUserData, exists = fs.existsSync }) => (
  exists(path.join(exeDir, '.Portable')) ? path.join(exeDir, 'userData') : defaultUserData
);

/** Small file-backed store around the pure helpers (sync on purpose: used before app ready). */
const createGpuStore = dataDir => {
  const settingsPath = path.join(dataDir, SETTINGS_FILE);
  const markerPath = path.join(dataDir, PENDING_MARKER_FILE);
  const read = () => {
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch {
      return sanitizeState(null);
    }
  };
  const write = state => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tempPath = `${settingsPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(sanitizeState(state), null, 2));
      fs.renameSync(tempPath, settingsPath);
      return true;
    } catch (error) {
      console.warn(`[GPU] Failed to save ${settingsPath}: ${error.message}`);
      return false;
    }
  };
  return {
    settingsPath,
    read,
    write,
    hasPendingMarker: () => fs.existsSync(markerPath),
    writePendingMarker: info => {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(markerPath, JSON.stringify(info || {}));
      } catch (error) {
        console.warn(`[GPU] Failed to write launch marker: ${error.message}`);
      }
    },
    clearPendingMarker: () => {
      try {
        fs.rmSync(markerPath, { force: true });
      } catch { /* ignore */ }
    },
  };
};

const RENDER_CONFIRM_MS = 10 * 1000;
const BLANK_CHECK_DELAY_MS = 3 * 1000;
const BLANK_CHECK_ATTEMPTS = 2;

/**
 * Wires the decision to Electron. Must be created before app 'ready' (disableHardwareAcceleration
 * only works then). `app` is Electron's app (or a test double); `onRelaunch(reason)` must quit and
 * relaunch; `onCompositingChanged(enabled)` forwards live changes to the renderer.
 */
const createGpuController = ({
  app,
  dataDir,
  argv = process.argv,
  env = process.env,
  platform = process.platform,
  versions,
  onRelaunch = () => {},
  onCompositingChanged = () => {},
  readGpuCompositing = () => false,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
}) => {
  const store = createGpuStore(dataDir);
  const forceDisable = readForceDisable(argv, env);
  const launch = applyLaunchState(store.read(), { pendingMarkerFound: store.hasPendingMarker(), ...versions, now: now() });
  if (launch.changed) store.write(launch.state);
  const launchMode = launch.state.hardwareAcceleration;
  const decision = decide(launch.state, platform, { forceDisable }, { fallback: launch.state.fallback, softwareThisLaunch: launch.softwareThisLaunch });
  // Only an 'auto' launch that actually uses the GPU is watched and may fall back.
  const watching = decision.useGpu && launchMode === 'auto';
  store.clearPendingMarker();
  if (watching) store.writePendingMarker({ at: new Date(now()).toISOString(), ...versions });
  if (!decision.useGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
  console.log(`[GPU] mode=${launchMode} useGpu=${decision.useGpu} reason=${decision.reason}`);

  const startedAt = now();
  let frontendLoaded = false;
  let rendered = false;
  let crashCount = 0;
  let fallbackRecorded = false;
  let relaunching = false;

  const recordFallback = reason => {
    if (!watching || fallbackRecorded) return false;
    fallbackRecorded = true;
    const state = store.read();
    state.fallback = makeFallback(reason, versions, now());
    store.write(state);
    store.clearPendingMarker();
    console.warn(`[GPU] Fallback to software rendering recorded: ${reason}`);
    return true;
  };
  const fallBackAndRelaunch = reason => {
    if (relaunching || !recordFallback(reason)) return;
    relaunching = true;
    onRelaunch(reason);
  };

  const confirmRendered = win => {
    if (fallbackRecorded || !win || win.isDestroyed()) return;
    store.clearPendingMarker();
    const state = store.read();
    if (state.unconfirmedLaunches) {
      state.unconfirmedLaunches = 0;
      store.write(state);
    }
  };

  const checkBlank = async (win, attempt) => {
    if (fallbackRecorded || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    try {
      const image = await win.webContents.capturePage();
      if (!image || image.isEmpty()) return;
      const bitmap = image.resize({ width: 48 }).toBitmap();
      if (!isUniformBitmap(bitmap)) return;
      if (attempt < BLANK_CHECK_ATTEMPTS) {
        schedule(() => { void checkBlank(win, attempt + 1); }, BLANK_CHECK_DELAY_MS);
        return;
      }
      fallBackAndRelaunch('blank-window');
    } catch { /* capturePage unsupported or failed: ignore */ }
  };

  const savedMode = () => store.read().hardwareAcceleration;
  const getStatus = () => {
    const saved = store.read();
    const next = decide(saved, platform, { forceDisable }, { fallback: saved.fallback });
    return {
      mode: saved.hardwareAcceleration,
      launchMode,
      useGpu: decision.useGpu,
      reason: decision.reason,
      gpuCompositing: Boolean(readGpuCompositing()),
      fallback: saved.fallback ? { reason: saved.fallback.reason, at: saved.fallback.at } : null,
      forceDisable,
      restartRequired: next.useGpu !== decision.useGpu,
    };
  };

  return {
    decision,
    launchMode,
    savedMode,
    getStatus,
    /** Validates strictly; an explicit choice also clears any recorded fallback (manual GPU retry). */
    setMode(mode) {
      const value = normalizeMode(mode);
      if (!value) throw new Error('Invalid hardwareAcceleration value.');
      const state = store.read();
      state.hardwareAcceleration = value;
      state.fallback = null;
      state.unconfirmedLaunches = 0;
      if (!store.write(state)) throw new Error('Failed to save hardware acceleration setting.');
      return getStatus();
    },
    attachWindow(win) {
      win.webContents.on('did-finish-load', () => {
        if (!String(win.webContents.getURL() || '').startsWith('data:')) frontendLoaded = true;
      });
    },
    /** Renderer reported real UI painted (after mount + two animation frames). */
    onRendered(win) {
      if (rendered) return;
      rendered = true;
      if (!watching) return;
      schedule(() => confirmRendered(win), RENDER_CONFIRM_MS);
      schedule(() => { void checkBlank(win, 1); }, BLANK_CHECK_DELAY_MS);
    },
    onChildProcessGone(details) {
      if (!isGpuCrash(details)) return;
      crashCount += 1;
      const msSinceStart = now() - startedAt;
      console.warn(`[GPU] GPU process gone (${details.reason}), count=${crashCount}`);
      if (watching && shouldFallbackOnGpuCrash({ crashCount, msSinceStart })) {
        // Early in the launch: relaunch in software right away. Later on, the user may have live
        // sessions, so only record the fallback for the next launch (Chromium falls back itself).
        if (msSinceStart <= EARLY_CRASH_WINDOW_MS) fallBackAndRelaunch('gpu-crash');
        else recordFallback('gpu-crash');
      }
      schedule(() => onCompositingChanged(fallbackRecorded ? false : Boolean(readGpuCompositing())), 1500);
    },
    /** A normal quit is not a failed launch once the UI rendered (or if startup failed before the frontend loaded). */
    beforeQuit() {
      if (relaunching || !watching) return;
      if (rendered || !frontendLoaded) store.clearPendingMarker();
    },
  };
};

module.exports = {
  createGpuController,
  HARDWARE_ACCELERATION_MODES,
  UNCONFIRMED_LAUNCH_LIMIT,
  applyLaunchState,
  createGpuStore,
  decide,
  isGpuCrash,
  isUniformBitmap,
  makeFallback,
  normalizeMode,
  readForceDisable,
  resolveDataDir,
  sanitizeState,
  shouldFallbackOnGpuCrash,
};

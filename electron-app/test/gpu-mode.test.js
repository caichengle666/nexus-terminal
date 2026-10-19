const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyLaunchState,
  createGpuController,
  decide,
  isGpuCrash,
  isUniformBitmap,
  normalizeMode,
  readForceDisable,
  resolveDataDir,
  sanitizeState,
  shouldFallbackOnGpuCrash,
} = require('../gpu-mode');

const versions = { appVersion: '1.0.0', electronVersion: '43.1.1' };
const fallback = (overrides = {}) => ({ fallback: true, reason: 'gpu-crash', ...versions, at: '2026-01-01T00:00:00.000Z', ...overrides });

test('settings validation accepts exactly auto/on/off', () => {
  for (const mode of ['auto', 'on', 'off']) assert.equal(normalizeMode(mode), mode);
  for (const bad of ['Auto', ' on', 'true', '', null, undefined, 1, {}, ['on']]) assert.equal(normalizeMode(bad), null);
  assert.equal(sanitizeState({ hardwareAcceleration: 'turbo' }).hardwareAcceleration, 'auto');
  assert.deepEqual(sanitizeState('garbage'), { hardwareAcceleration: 'auto', fallback: null, unconfirmedLaunches: 0 });
  assert.equal(sanitizeState({ fallback: { reason: 'x' } }).fallback, null);
});

test('decide: GPU on by default on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(decide({}, platform, {}, {}), { useGpu: true, reason: 'auto' });
  }
});

test('decide: manual settings, flags and fallback', () => {
  assert.deepEqual(decide({ hardwareAcceleration: 'off' }, 'win32', {}, {}), { useGpu: false, reason: 'setting-off' });
  assert.deepEqual(decide({ hardwareAcceleration: 'on' }, 'win32', {}, { fallback: fallback() }), { useGpu: true, reason: 'setting-on' });
  assert.deepEqual(decide({ hardwareAcceleration: 'on' }, 'win32', { forceDisable: 'cli-flag' }, {}), { useGpu: false, reason: 'cli-flag' });
  assert.deepEqual(decide({ hardwareAcceleration: 'auto' }, 'win32', {}, { fallback: fallback() }), { useGpu: false, reason: 'fallback:gpu-crash' });
  assert.deepEqual(decide({}, 'win32', {}, { softwareThisLaunch: true }), { useGpu: false, reason: 'unconfirmed-launch' });
});

test('escape hatch flags', () => {
  assert.equal(readForceDisable(['electron', '.', '--disable-gpu'], {}), 'cli-flag');
  assert.equal(readForceDisable(['app', '--disable-hardware-acceleration'], {}), 'cli-flag');
  assert.equal(readForceDisable([], { NEXUS_DISABLE_GPU: '1' }), 'env');
  assert.equal(readForceDisable([], { NEXUS_DISABLE_GPU: '0' }), null);
  assert.equal(readForceDisable(['--disable-gpu-sandbox'], {}), null);
});

test('sentinel: one unconfirmed launch runs in software, two in a row record a fallback', () => {
  const first = applyLaunchState({}, { pendingMarkerFound: true, ...versions, now: 0 });
  assert.equal(first.softwareThisLaunch, true);
  assert.equal(first.state.unconfirmedLaunches, 1);
  assert.equal(first.state.fallback, null);
  // The software launch writes no marker; the next GPU launch also fails to confirm.
  const between = applyLaunchState(first.state, { pendingMarkerFound: false, ...versions });
  assert.equal(between.softwareThisLaunch, false);
  assert.equal(between.changed, false);
  const second = applyLaunchState(between.state, { pendingMarkerFound: true, ...versions, now: 0 });
  assert.equal(second.state.fallback.reason, 'startup-unconfirmed');
  assert.equal(second.state.fallback.appVersion, '1.0.0');
  assert.equal(decide(second.state, 'win32', {}, { fallback: second.state.fallback }).useGpu, false);
});

test('version change retries the GPU once', () => {
  const sameVersion = applyLaunchState({ fallback: fallback(), unconfirmedLaunches: 2 }, { pendingMarkerFound: false, ...versions });
  assert.ok(sameVersion.state.fallback);
  const appUpdate = applyLaunchState({ fallback: fallback(), unconfirmedLaunches: 2 }, { pendingMarkerFound: false, appVersion: '1.0.1', electronVersion: '43.1.1' });
  assert.equal(appUpdate.state.fallback, null);
  assert.equal(appUpdate.state.unconfirmedLaunches, 0);
  assert.equal(appUpdate.changed, true);
  const electronUpdate = applyLaunchState({ fallback: fallback() }, { pendingMarkerFound: false, appVersion: '1.0.0', electronVersion: '44.0.0' });
  assert.equal(electronUpdate.state.fallback, null);
});

test('GPU crash classification and thresholds', () => {
  assert.equal(isGpuCrash({ type: 'GPU', reason: 'crashed' }), true);
  assert.equal(isGpuCrash({ type: 'GPU', reason: 'clean-exit' }), false);
  assert.equal(isGpuCrash({ type: 'GPU', reason: 'killed' }), false);
  assert.equal(isGpuCrash({ type: 'Utility', reason: 'crashed' }), false);
  assert.equal(shouldFallbackOnGpuCrash({ crashCount: 1, msSinceStart: 30_000 }), true);
  assert.equal(shouldFallbackOnGpuCrash({ crashCount: 1, msSinceStart: 120_000 }), false);
  assert.equal(shouldFallbackOnGpuCrash({ crashCount: 2, msSinceStart: 3_600_000 }), true);
});

test('blank detection checks uniformity, not whiteness', () => {
  const make = (pixels, fn) => {
    const buffer = Buffer.alloc(pixels * 4);
    for (let i = 0; i < pixels; i += 1) buffer.set(fn(i), i * 4);
    return buffer;
  };
  assert.equal(isUniformBitmap(make(48 * 30, () => [255, 255, 255, 255])), true);
  assert.equal(isUniformBitmap(make(48 * 30, () => [16, 18, 22, 255])), true);
  assert.equal(isUniformBitmap(make(48 * 30, i => (i % 7 === 0 ? [40, 40, 40, 255] : [250, 250, 250, 255]))), false);
  assert.equal(isUniformBitmap(make(48 * 30, i => [i % 256, 100, 100, 255])), false);
  assert.equal(isUniformBitmap(Buffer.alloc(8)), false);
});

test('portable mode keeps GPU settings next to the exe', () => {
  assert.equal(resolveDataDir({ exeDir: '/app', defaultUserData: '/home/u/.config/x', exists: () => true }), path.join('/app', 'userData'));
  assert.equal(resolveDataDir({ exeDir: '/app', defaultUserData: '/home/u/.config/x', exists: () => false }), '/home/u/.config/x');
});

const fakeApp = () => {
  const calls = [];
  return {
    calls,
    disableHardwareAcceleration: () => calls.push('disable'),
    commandLine: { appendSwitch: name => calls.push(name) },
  };
};
const fakeWindow = () => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { on() {}, getURL: () => 'http://localhost' } });

test('controller: marker lifecycle, crash fallback and strict setMode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-mode-'));
  const marker = path.join(dir, 'gpu-launch-pending');
  const timers = [];
  const schedule = fn => timers.push(fn);
  let clock = 0;

  // Launch 1: auto, GPU on, marker written; app renders and stays up → marker cleared.
  let app = fakeApp();
  let controller = createGpuController({ app, dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  assert.equal(controller.decision.useGpu, true);
  assert.deepEqual(app.calls, []);
  assert.equal(fs.existsSync(marker), true);
  controller.onRendered(fakeWindow());
  timers.splice(0).forEach(fn => fn());
  assert.equal(fs.existsSync(marker), false);

  // Launch 2: killed before rendering (marker left behind) → launch 3 runs in software.
  controller = createGpuController({ app: fakeApp(), dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  assert.equal(fs.existsSync(marker), true);
  app = fakeApp();
  controller = createGpuController({ app, dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  assert.equal(controller.decision.reason, 'unconfirmed-launch');
  assert.deepEqual(app.calls, ['disable', 'disable-gpu', 'disable-gpu-compositing']);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(controller.getStatus().restartRequired, true);

  // Launch 4: GPU again; an early GPU crash records a fallback and relaunches once.
  const relaunches = [];
  const changes = [];
  controller = createGpuController({
    app: fakeApp(), dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock,
    onRelaunch: reason => relaunches.push(reason), onCompositingChanged: enabled => changes.push(enabled),
  });
  clock = 5_000;
  controller.onChildProcessGone({ type: 'GPU', reason: 'crashed' });
  controller.onChildProcessGone({ type: 'GPU', reason: 'crashed' });
  timers.splice(0).forEach(fn => fn());
  assert.deepEqual(relaunches, ['gpu-crash']);
  assert.deepEqual(changes, [false, false]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'gpu-settings.json'), 'utf8'));
  assert.equal(saved.fallback.reason, 'gpu-crash');

  // Launch 5: fallback applies; the user explicitly choosing a mode clears it.
  controller = createGpuController({ app: fakeApp(), dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  assert.equal(controller.decision.reason, 'fallback:gpu-crash');
  assert.throws(() => controller.setMode('ON'));
  assert.throws(() => controller.setMode(undefined));
  const status = controller.setMode('auto');
  assert.equal(status.fallback, null);
  assert.equal(status.restartRequired, true);

  // A normal quit after rendering clears the marker; 'on' and 'off' are never watched.
  controller = createGpuController({ app: fakeApp(), dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  controller.onRendered(fakeWindow());
  timers.length = 0;
  controller.beforeQuit();
  assert.equal(fs.existsSync(marker), false);
  controller.setMode('on');
  controller = createGpuController({ app: fakeApp(), dataDir: dir, argv: [], env: {}, versions, schedule, now: () => clock });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(controller.decision.reason, 'setting-on');
  fs.rmSync(dir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const glass = await import(pathToFileURL(process.env.GLASS_EFFECT_MODULE).href);

const proDark = {
  '--app-bg-color': '#111827',
  '--text-color': '#e5e7eb',
  '--header-bg-color': '#0b1120',
  '--footer-bg-color': '#0b1120',
  '--border-color': '#374151',
  '--link-active-color': '#38bdf8',
};
const glassDark = {
  '--ui-effect': 'glass',
  '--app-bg-color': 'rgba(15, 20, 32, 0.52)',
  '--text-color': '#e8edf6',
  '--header-bg-color': 'rgba(12, 16, 26, 0.48)',
  '--footer-bg-color': 'rgba(12, 16, 26, 0.48)',
  '--border-color': 'rgba(255, 255, 255, 0.12)',
  '--glass-base-color': '#0b1220',
  '--glass-surface': 'rgba(18, 24, 38, 0.55)',
};

test('parseColor handles hex and rgba forms', () => {
  assert.deepEqual(glass.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(glass.parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(glass.parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(glass.parseColor('var(--x)'), null);
});

test('guessThemeMode', () => {
  assert.equal(glass.guessThemeMode(proDark), 'dark');
  assert.equal(glass.guessThemeMode({ '--app-bg-color': '#ffffff', '--text-color': '#333333' }), 'light');
  assert.equal(glass.guessThemeMode(glassDark), 'dark');
  assert.equal(glass.guessThemeMode({ '--ui-effect': 'glass', '--app-bg-color': 'rgba(255,255,255,0.55)', '--glass-base-color': '#dfe7f3' }), 'light');
});

test('solid theme with glass off is unchanged; glass on derives translucent vars', () => {
  assert.equal(glass.resolveEffectiveUiTheme(proDark, false), proDark);
  const derived = glass.resolveEffectiveUiTheme(proDark, true);
  assert.equal(derived['--ui-effect'], 'glass');
  assert.equal(derived['--glass-base-color'], '#111827');
  assert.match(derived['--app-bg-color'], /^color-mix\(in srgb, #111827 \d+%, transparent\)$/);
  assert.match(derived['--glass-surface-strong'], /#111827 86%/);
  assert.match(derived['--glass-backdrop'], /^radial-gradient/);
  assert.equal(derived['--glass-blur'], '22px');
  assert.equal(derived['--text-color'], proDark['--text-color']);
});

test('glass theme with glass on is unchanged; glass off becomes opaque', () => {
  assert.equal(glass.resolveEffectiveUiTheme(glassDark, true), glassDark);
  const solid = glass.resolveEffectiveUiTheme(glassDark, false);
  assert.equal(solid['--ui-effect'], undefined);
  for (const key of ['--app-bg-color', '--header-bg-color', '--border-color']) {
    assert.match(solid[key], /^#[0-9a-f]{6}$/, key);
  }
  assert.equal(solid['--text-color'], glassDark['--text-color']);
});

test('backdrop / shadow validation rejects unsafe values', () => {
  assert.ok(glass.isSafeGlassBackdrop('radial-gradient(1200px 800px at 8% 6%, rgba(56, 116, 255, 0.40), transparent 60%), linear-gradient(160deg, #0b1220 0%, #0a0f1c 100%)'));
  assert.ok(!glass.isSafeGlassBackdrop('url(https://evil.example/x.png)'));
  assert.ok(!glass.isSafeGlassBackdrop('linear-gradient(red, blue); color: red'));
  assert.ok(!glass.isSafeGlassBackdrop('linear-gradient(red, blue)} body {display:none'));
  assert.ok(!glass.isSafeGlassBackdrop('linear-gradient(red, url(x))'));
  assert.ok(!glass.isSafeGlassBackdrop('linear-gradient(red, blue'));
  assert.ok(!glass.isSafeGlassBackdrop(`linear-gradient(${'red, '.repeat(400)}blue)`));
  assert.ok(glass.isSafeGlassShadow('0 10px 30px rgba(0, 0, 0, 0.35)'));
  assert.ok(!glass.isSafeGlassShadow('0 0 1px red; background: url(x)'));
});

test('glass render mode: lite only in Electron without GPU compositing; override wins', () => {
  assert.equal(glass.resolveGlassRenderMode({ isElectron: true, gpuCompositing: false }), 'lite');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: true, gpuCompositing: null }), 'lite');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: true }), 'lite');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: true, gpuCompositing: true }), 'full');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: false }), 'full');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: false, gpuCompositing: false }), 'full');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: true, gpuCompositing: false, override: 'full' }), 'full');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: false, override: ' LITE ' }), 'lite');
  assert.equal(glass.resolveGlassRenderMode({ isElectron: false, override: 'bogus' }), 'full');
});

test('lite blur plan scales the blur radius to the downscaled canvas', () => {
  const plan = glass.computeLiteBlurPlan({ imageWidth: 3840, imageHeight: 2160, viewportWidth: 1920, viewportHeight: 1080, cssBlurPx: 22 });
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 720);
  // cover scale 0.5, 3x downscale => 1.5 screen px per canvas px
  assert.equal(plan.blurPx, 14.7);
  assert.equal(plan.pad, 30);
  const small = glass.computeLiteBlurPlan({ imageWidth: 800, imageHeight: 600, viewportWidth: 1440, viewportHeight: 900, cssBlurPx: 22 });
  assert.equal(small.width, 800);
  assert.ok(small.blurPx >= 1 && small.blurPx < 22);
  assert.equal(glass.computeLiteBlurPlan({ imageWidth: 0, imageHeight: 600, viewportWidth: 1, viewportHeight: 1, cssBlurPx: 22 }), null);
});

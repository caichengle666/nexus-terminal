'use strict';

// Pure helpers for persisting / restoring the main window's position.
// Kept free of Electron imports so they can be unit tested with node --test.

const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;
// A restored window must keep at least this much of itself on a display, so
// its title bar can still be grabbed.
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const intersection = (a, b) => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
};

/** True when `bounds` overlaps one of the work areas enough to be usable. */
function isVisibleOnSomeDisplay(bounds, workAreas) {
  return (workAreas || []).some((area) => {
    if (!area) return false;
    const overlap = intersection(bounds, area);
    return overlap.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width)
      && overlap.height >= Math.min(MIN_VISIBLE_HEIGHT, bounds.height);
  });
}

/**
 * Turns a saved window state into BrowserWindow options.
 * @param {unknown} saved            value from the store ({x,y,width,height,isMaximized})
 * @param {{x:number,y:number,width:number,height:number}[]} workAreas  all displays' work areas
 * @param {{x:number,y:number,width:number,height:number}} primaryWorkArea
 * @param {{width:number,height:number}} defaults
 * @returns {{width:number,height:number,x?:number,y?:number,isMaximized:boolean}}
 */
function resolveWindowState(saved, workAreas, primaryWorkArea, defaults = { width: 1200, height: 800 }) {
  const state = saved && typeof saved === 'object' ? saved : {};
  const primary = primaryWorkArea || { x: 0, y: 0, width: defaults.width, height: defaults.height };
  let width = isFiniteNumber(state.width) ? Math.round(state.width) : defaults.width;
  let height = isFiniteNumber(state.height) ? Math.round(state.height) : defaults.height;
  width = Math.max(MIN_WIDTH, width);
  height = Math.max(MIN_HEIGHT, height);
  const isMaximized = state.isMaximized === true;

  if (isFiniteNumber(state.x) && isFiniteNumber(state.y)) {
    const bounds = { x: Math.round(state.x), y: Math.round(state.y), width, height };
    if (isVisibleOnSomeDisplay(bounds, workAreas)) {
      return { ...bounds, isMaximized };
    }
  }

  // Off-screen (display unplugged / resolution changed) or never saved:
  // fit into the primary display and center there.
  width = Math.min(width, primary.width);
  height = Math.min(height, primary.height);
  return {
    width,
    height,
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    isMaximized,
  };
}

/** Snapshot to persist: the un-maximized bounds plus the maximized flag. */
function captureWindowState(win) {
  const bounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: typeof win.isMaximized === 'function' ? win.isMaximized() : false,
  };
}

module.exports = {
  captureWindowState,
  isVisibleOnSomeDisplay,
  resolveWindowState,
};

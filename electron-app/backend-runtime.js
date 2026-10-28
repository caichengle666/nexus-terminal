'use strict';

// The packaged backend runs on Electron's own embedded Node.js: the app binary is
// started again with ELECTRON_RUN_AS_NODE=1 (the runAsNode fuse is kept on), so no
// separate Node.js runtime has to ship with the app.
function getBackendSpawnSpec({ execPath, entryPath, env }) {
  if (!execPath) throw new Error('Electron executable path is unknown');
  if (!entryPath) throw new Error('Backend entry path is unknown');
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  // Never let the parent's Node options leak into the backend (debug flags etc.).
  delete childEnv.NODE_OPTIONS;
  return { command: execPath, args: [entryPath], env: childEnv };
}

module.exports = { getBackendSpawnSpec };

'use strict';
// Keeps the settings in one JSON file. On Railway that file needs a volume to survive a redeploy.

const fs = require('fs');
const path = require('path');

function createStore(dir, { log = () => {}, env = process.env } = {}) {
  const file = path.join(dir, 'state.json');
  let writable = true;

  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  function save(state) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(state));
      fs.renameSync(file + '.tmp', file);
      writable = true;
      return true;
    } catch (e) {
      if (writable) log(`Could not save settings in ${dir}: ${e.message}`);
      writable = false;
      return false;
    }
  }
  // On Railway a folder only outlives a redeploy if a volume is mounted there.
  function isPersistent() {
    if (!writable) return false;
    const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_SERVICE_ID || env.RAILWAY_PROJECT_ID);
    if (!onRailway) return true;
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount) return false;
    const d = path.resolve(dir), m = path.resolve(mount);
    return d === m || d.startsWith(m.endsWith(path.sep) ? m : m + path.sep);
  }
  return { load, save, isPersistent, file };
}

module.exports = { createStore };

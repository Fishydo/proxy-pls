// Dynamic WISP URL Configuration with Multi-Server Failover
const basePath = '/Staticsj/';

// ──────────────────────────────────────────────
// WISP Server Pool — add/remove servers here
// ──────────────────────────────────────────────
const WISP_SERVERS = [
  "wss://dash.goip.de/wisp/",
  "wss://wisp.rhw.one/wisp/",
  "wss://wisp.mercurywork.shop/wisp/",
  "wss://wisp.tomp.app/wisp/",
  "wss://wisp2.rhw.one/wisp/"
];

const DEFAULT_WISP = WISP_SERVERS[0];

// ──────────────────────────────────────────────
// Tuning knobs
// ──────────────────────────────────────────────
const HEALTH_CHECK_TIMEOUT_MS  = 4000;   // max ms before a server is "too slow"
const HEALTH_CHECK_INTERVAL_MS = 30000;  // background re-check every 30 s
const MAX_CONSECUTIVE_FAILS    = 2;      // failures before auto-switch
const SLOW_THRESHOLD_MS        = 3000;   // anything above this = "slow"

let _CONFIG = {
  wispurl:  localStorage.getItem("proxServer") || DEFAULT_WISP,
  bareurl:  undefined
};

// Per-server bookkeeping
const serverStats = new Map();
WISP_SERVERS.forEach(url => {
  serverStats.set(url, {
    alive:           null,   // null = unknown, true/false after check
    latency:         Infinity,
    consecutiveFails: 0,
    lastChecked:     0
  });
});

// ──────────────────────────────────────────────
// URL validation
// ──────────────────────────────────────────────
const validWispPatterns = [
  /^wss:\/\/.+\.\w+\/wisp\/?$/,
  /^wss:\/\/[\d.]+:\d+\/wisp\/?$/,
  /^wss:\/\/localhost:\d+\/wisp\/?$/
];

function isValidWispUrl(url) {
  try {
    if (!url || typeof url !== 'string') return false;
    const u = new URL(url);
    if (u.protocol !== 'wss:') return false;
    return validWispPatterns.some(p => p.test(url));
  } catch {
    console.warn('[WISP] Invalid URL format:', url);
    return false;
  }
}

console.assert(
  isValidWispUrl("wss://wisp.rhw.one/wisp/"),
  "Default WISP URL should pass validation"
);

// ──────────────────────────────────────────────
// Health-check a single server via WebSocket ping
// Resolves with latency (ms) or rejects on failure
// ──────────────────────────────────────────────
function checkServer(url) {
  return new Promise((resolve, reject) => {
    if (!isValidWispUrl(url)) return reject(new Error('invalid url'));

    const start = performance.now();
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error('timeout'));
      }
    }, HEALTH_CHECK_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latency = Math.round(performance.now() - start);
      ws.close();
      resolve(latency);
    });

    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('connection error'));
    });
  });
}

// ──────────────────────────────────────────────
// Probe every server in the pool, update stats
// ──────────────────────────────────────────────
async function probeAllServers() {
  console.log('[WISP] Probing all servers…');

  const results = await Promise.allSettled(
    WISP_SERVERS.map(async url => {
      const stats = serverStats.get(url);
      try {
        const latency = await checkServer(url);
        stats.alive           = true;
        stats.latency         = latency;
        stats.consecutiveFails = 0;
        stats.lastChecked     = Date.now();
        console.log(`[WISP]  ✔ ${url}  ${latency} ms`);
        return { url, latency };
      } catch (err) {
        stats.alive            = false;
        stats.latency          = Infinity;
        stats.consecutiveFails += 1;
        stats.lastChecked      = Date.now();
        console.warn(`[WISP]  ✘ ${url}  (${err.message})`);
        throw err;
      }
    })
  );

  return results;
}

// ──────────────────────────────────────────────
// Pick the best available server (lowest latency)
// ──────────────────────────────────────────────
function getBestServer() {
  let best     = null;
  let bestTime = Infinity;

  for (const [url, stats] of serverStats) {
    if (stats.alive && stats.latency < bestTime) {
      best     = url;
      bestTime = stats.latency;
    }
  }
  return best;
}

// ──────────────────────────────────────────────
// Switch to a different server
// ──────────────────────────────────────────────
function switchToServer(newUrl, reason) {
  if (!newUrl || newUrl === _CONFIG.wispurl) return;
  if (!isValidWispUrl(newUrl)) {
    console.warn('[WISP] Candidate URL invalid, not switching:', newUrl);
    return;
  }

  const oldUrl = _CONFIG.wispurl;
  _CONFIG.wispurl = newUrl;
  localStorage.setItem("proxServer", newUrl);

  console.log(`[WISP] ⇢ Switched from ${oldUrl} → ${newUrl}  (${reason})`);

  // Notify service worker
  if (navigator?.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'config',
      wispurl: newUrl
    });
  }

  // Dispatch event for the rest of the app
  window.dispatchEvent(new CustomEvent('wispUrlUpdated', {
    detail: { oldUrl, newUrl, bareUrl: _CONFIG.bareurl, reason }
  }));
}

// ──────────────────────────────────────────────
// Evaluate current server & auto-switch if needed
// ──────────────────────────────────────────────
async function evaluateAndSwitch() {
  const current      = _CONFIG.wispurl;
  const currentStats = serverStats.get(current);

  // If the current server is user-chosen and still fine, leave it
  if (currentStats?.alive && currentStats.latency < SLOW_THRESHOLD_MS) {
    return; // all good
  }

  // Current server is dead, slow, or unknown — find something better
  const best = getBestServer();

  if (best && best !== current) {
    const reason =
      !currentStats?.alive
        ? 'current server unreachable'
        : currentStats.latency >= SLOW_THRESHOLD_MS
          ? `current server slow (${currentStats.latency} ms)`
          : 'better server available';
    switchToServer(best, reason);
  } else if (!best) {
    console.warn('[WISP] All servers appear down — keeping current.');
  }
}

// ──────────────────────────────────────────────
// Quick-check just the active server; switch fast
// if it fails MAX_CONSECUTIVE_FAILS times in a row
// ──────────────────────────────────────────────
async function quickCheckCurrent() {
  const current = _CONFIG.wispurl;
  const stats   = serverStats.get(current);
  if (!stats) return;                       // custom URL, skip

  try {
    const latency = await checkServer(current);
    stats.alive           = true;
    stats.latency         = latency;
    stats.consecutiveFails = 0;
    stats.lastChecked     = Date.now();

    if (latency >= SLOW_THRESHOLD_MS) {
      console.warn(`[WISP] Current server slow (${latency} ms), looking for alternatives…`);
      await probeAllServers();
      await evaluateAndSwitch();
    }
  } catch {
    stats.alive            = false;
    stats.consecutiveFails += 1;
    stats.lastChecked      = Date.now();

    console.warn(
      `[WISP] Current server failed (${stats.consecutiveFails}/${MAX_CONSECUTIVE_FAILS})`
    );

    if (stats.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      console.warn('[WISP] Max failures reached — probing all servers…');
      await probeAllServers();
      await evaluateAndSwitch();
    }
  }
}

// ──────────────────────────────────────────────
// Manual update (e.g. user picks a server)
// ──────────────────────────────────────────────
function updateWispUrl(newUrl) {
  try {
    if (!newUrl || newUrl === _CONFIG.wispurl) {
      console.log('[WISP] URL unchanged or empty, skipping update');
      return;
    }
    if (!isValidWispUrl(newUrl)) {
      console.warn('[WISP] Invalid URL format:', newUrl);
      return;
    }
    switchToServer(newUrl, 'manual update');
  } catch (error) {
    console.error('[WISP] Error updating URL:', error);
  }
}

// ──────────────────────────────────────────────
// Listen for localStorage changes
// ──────────────────────────────────────────────
window.addEventListener('storage', (event) => {
  if (event.key === 'proxServer') updateWispUrl(event.newValue);
});
window.addEventListener('localStorageUpdate', (event) => {
  if (event.key === 'proxServer') updateWispUrl(event.newValue);
});

// ──────────────────────────────────────────────
// Bootstrap: probe everything on load, then start
// the background health-check loop
// ──────────────────────────────────────────────
(async function init() {
  try {
    await probeAllServers();
    await evaluateAndSwitch();
  } catch (err) {
    console.error('[WISP] Initial probe failed:', err);
  }

  // Periodic background check
  setInterval(async () => {
    try {
      await quickCheckCurrent();
    } catch (err) {
      console.error('[WISP] Background check error:', err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
})();

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _CONFIG,
    WISP_SERVERS,
    isValidWispUrl,
    updateWispUrl,
    probeAllServers,
    evaluateAndSwitch,
    getBestServer,
    serverStats,
    basePath
  };
}


const DEFAULT_WISP = "wss://dash.goip.de/wisp/";
const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);
self.basePath = self.basePath || basePath;

self.$scramjet = {
    files: {
        wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
        sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js",
    }
};

importScripts("https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js");
importScripts("https://cdn.jsdelivr.net/npm/@mercuryworkshop/bare-mux/dist/index.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker({
    prefix: basePath + "scramjet/"
});

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        try {
            await scramjet.loadConfig();
        } catch (error) {
            console.warn("SW: Failed to load scramjet config.", error);
        }
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        return fetch(event.request);
    })());
});

let wispConfig = {};
let resolveConfigReady;
const configReadyPromise = new Promise(resolve => resolveConfigReady = resolve);

self.addEventListener("message", ({ data }) => {
    if (data.type === "config" && data.wispurl) {
        wispConfig.wispurl = data.wispurl;
        console.log("SW: Received config", wispConfig);
        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }
});

// Fallback if config is never received (prevents 500 error)
setTimeout(() => {
    if (!wispConfig.wispurl && resolveConfigReady) {
        console.warn("SW: Config timeout, using default Wisp");
        wispConfig.wispurl = DEFAULT_WISP;
        resolveConfigReady();
        resolveConfigReady = null;
    }
}, 1000);

scramjet.addEventListener("request", async (e) => {
    e.response = (async () => {
        if (!scramjet.client) {
            await configReadyPromise;
            if (!wispConfig.wispurl) return new Response("WISP URL missing", { status: 500 });

            const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
            await connection.setTransport("https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", [{ wisp: wispConfig.wispurl }]);
            scramjet.client = connection;
        }
        const MAX_RETRIES = 2;
        const RETRYABLE_ERRORS = ["connect", "eof", "handshake", "reset"];
        let lastErr;

        for (let i = 0; i <= MAX_RETRIES; i++) {
            try {
                return await scramjet.client.fetch(e.url, {
                    method: e.method,
                    body: e.body,
                    headers: e.requestHeaders,
                    credentials: "include",
                    mode: e.mode === "cors" ? e.mode : "same-origin",
                    cache: e.cache,
                    redirect: "manual",
                    duplex: "half",
                });
            } catch (err) {
                lastErr = err;
                const errMsg = err.message.toLowerCase();
                const isRetryable = RETRYABLE_ERRORS.some((message) => errMsg.includes(message));

                if (!isRetryable || i === MAX_RETRIES || e.method !== 'GET') break;

                console.warn(`Scramjet retry ${i + 1}/${MAX_RETRIES} for ${e.url} due to: ${err.message}`);
                await new Promise(r => setTimeout(r, 500 * (i + 1)));
            }
        }

        console.error("Scramjet Final Fetch Error:", lastErr);
        return new Response("Scramjet Fetch Error: " + lastErr.message, { status: 502 });
    })();
});

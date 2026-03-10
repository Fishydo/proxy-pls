// =====================================================
// CONFIGURATION
// =====================================================
const DEFAULT_WISP = "wss://dash.goip.de/wisp/";
const WISP_SERVERS = [
    { name: "DaydreamX's Wisp", url: "wss://dash.goip.de/wisp/" },
    { name: "Space's Wisp", url: "wss://register.goip.it/wisp/" },
    { name: "Rhw's Wisp", url: "wss://wisp.rhw.one/wisp/" }
];
const SEARCH_URL = "https://search.brave.com/search?q=";
const EXTENSIONS_KEY = "customExtensions";
const AUTORUN_KEY   = "autorunSites";   // { "extensionId|||github.com": true }

if (!localStorage.getItem("proxServer")) {
    localStorage.setItem("proxServer", DEFAULT_WISP);
}

let wispUrl = localStorage.getItem("proxServer") || DEFAULT_WISP;

// =====================================================
// BROWSER STATE
// =====================================================
if (typeof BareMux === "undefined") {
    BareMux = { BareMuxConnection: class { constructor() {} async setTransport() {} } };
}

let scramjet;
let connection;
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let extensionsVisible = false;

// =====================================================
// INITIALIZATION
// =====================================================
document.addEventListener("DOMContentLoaded", async () => {
    let basePath = location.pathname.replace(/[^/]*$/, "");
    if (!basePath.endsWith("/")) basePath += "/";

    const { ScramjetController } = $scramjetLoadController();
    scramjet = new ScramjetController({
        prefix: `${basePath}scramjet/`,
        files: {
            wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
            all: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js",
            sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js"
        }
    });

    try {
        await scramjet.init();
        await initializeBrowser();
        setupTransport(basePath).catch((error) => {
            console.error("Failed to initialize proxy transport:", error);
            showErrorMessage("Proxy transport failed to initialize. Reload or change Wisp.");
        });
    } catch (error) {
        console.error("Failed to initialize proxy UI:", error);
        showErrorMessage("Failed to initialize proxy. Reload or change Wisp.");
    }
});

async function setupTransport(basePath) {
    if (!("serviceWorker" in navigator)) return;

    const reg = await navigator.serviceWorker.register(`${basePath}sw.js`, { scope: basePath });
    reg.update();

    // Keep the service worker in sync with the selected Wisp server so
    // proxied page fetches and websocket upgrades use the same transport.
    postWispConfigToServiceWorker(reg);

    connection = new BareMux.BareMuxConnection(`${basePath}bareworker.js`);
    await applyTransport();
}

function postWispConfigToServiceWorker(registration) {
    const configMessage = { type: "config", wispurl: wispUrl, wispCandidates: WISP_SERVERS.map((server) => server.url) };
    const target = registration?.active || registration?.waiting || registration?.installing;
    target?.postMessage(configMessage);
    navigator.serviceWorker.controller?.postMessage(configMessage);
}

async function applyTransport() {
    if (!connection) return;
    await connection.setTransport(
        "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs",
        [{ wisp: wispUrl }]
    );
}

// =====================================================
// BROWSER UI
// =====================================================
async function initializeBrowser() {
    const root = document.getElementById("app");
    if (!root) {
        console.error("App container missing.");
        return;
    }

    root.innerHTML = `
<div class="browser-container chrome-ui">
  <div class="tab-strip">
    <div class="tab-strip-left"><div class="tabs" id="tabs-container"></div></div>
    <div class="tab-strip-right">
      <button class="tab-action tab-action-new" id="new-tab-btn" title="New tab"><i class="fa-solid fa-plus"></i></button>
    </div>
  </div>

  <div class="toolbar">
    <div class="nav-controls">
      <button id="back-btn" title="Back"><i class="fa-solid fa-chevron-left"></i></button>
      <button id="fwd-btn" title="Forward"><i class="fa-solid fa-chevron-right"></i></button>
      <button id="reload-btn" title="Reload"><i class="fa-solid fa-rotate-right"></i></button>
      <button id="home-btn-nav" title="Home"><i class="fa-solid fa-house"></i></button>
    </div>

    <div class="address-wrapper">
      <div class="security-indicator"><i class="fa-solid fa-lock"></i></div>
      <input id="address-bar" autocomplete="off" placeholder="Search Google or type a URL">
      <div class="omnibox-actions">
        <button id="extensions-btn" title="Extensions"><i class="fa-solid fa-puzzle-piece"></i></button>
        <button id="settings-btn" title="Settings"><i class="fa-solid fa-gear"></i></button>
        <button id="devtools-btn" title="Developer tools"><i class="fa-solid fa-code"></i></button>
      </div>
    </div>
  </div>

  <div class="loading-bar-container"><div class="loading-bar" id="loading-bar"></div></div>
  <div class="iframe-container" id="iframe-container"></div>

  <div class="extensions-menu hidden" id="extensions-menu">
    <div class="extensions-header">Extensions</div>
    <div id="extensions-list"></div>
    <div id="extensions-empty">No extensions</div>
  </div>
</div>`;

    document.getElementById("back-btn").onclick = () => getActiveTab()?.frame.back();
    document.getElementById("fwd-btn").onclick = () => getActiveTab()?.frame.forward();
    document.getElementById("reload-btn").onclick = () => getActiveTab()?.frame.reload();
    document.getElementById("new-tab-btn").onclick = () => createTab(true);
    document.getElementById("home-btn-nav").onclick = openHome;
    document.getElementById("devtools-btn").onclick = openDevTools;
    document.getElementById("settings-btn").onclick = openSettings;
    document.getElementById("extensions-btn").onclick = () => {
        const menu = document.getElementById("extensions-menu");
        extensionsVisible = !extensionsVisible;
        menu.classList.toggle("hidden", !extensionsVisible);
        renderExtensionsMenu();
    };

    const addrBar = document.getElementById("address-bar");
    addrBar.onkeyup = (e) => {
        if (e.key === "Enter") handleSubmit();
    };

    const savedTheme = localStorage.getItem("theme") || "dark";
    document.documentElement.dataset.theme = savedTheme;

    window.addEventListener("message", async (event) => {
        const data = event.data || {};
        if (data.type === "navigate" && data.url) handleSubmit(data.url);
        if (data.type === "extensionsUpdated") renderExtensionsMenu();
        if (data.type === "setTheme" && data.theme) {
            localStorage.setItem("theme", data.theme);
            document.documentElement.dataset.theme = data.theme;
        }
        if (data.type === "setWisp" && data.url) {
            wispUrl = data.url;
            localStorage.setItem("proxServer", data.url);
            postWispConfigToServiceWorker(await navigator.serviceWorker.getRegistration());
            await applyTransport();
        }
    });

    window.addEventListener("resize", updateTabsUI);
    createTab(true);
}

function showErrorMessage(message) {
    alert(message);
}

function openHome() {
    handleSubmit("NT.html");
}

function openSettings() {
    const tab = getActiveTab();
    if (!tab) return;

    tab.frame.frame.src = "settings.html";
    document.getElementById("address-bar").value = "settings.html";
}

function openDevTools() {
    const tab = getActiveTab();
    if (!tab) return;

    const target = tab.currentUrl || tab.url;
    if (!target || target.endsWith("NT.html")) {
        alert("Open a page first, then use developer tools.");
        return;
    }

    const devToolsUrl = `view-source:${target}`;
    window.open(devToolsUrl, "_blank", "noopener,noreferrer");
}

// =====================================================
// EXTENSION STORAGE  (localStorage: "customExtensions")
// =====================================================
function getExtensions() {
    try {
        return JSON.parse(localStorage.getItem(EXTENSIONS_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveExtensions(extensions) {
    localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(extensions));
}

// =====================================================
// AUTORUN STORAGE  (localStorage: "autorunSites")
// Shape: { "extensionId|||github.com": true, ... }
// The site key is always the decoded hostname, e.g. "github.com"
// =====================================================
function getAutorunMap() {
    try {
        return JSON.parse(localStorage.getItem(AUTORUN_KEY) || "{}");
    } catch {
        return {};
    }
}

function saveAutorunMap(map) {
    localStorage.setItem(AUTORUN_KEY, JSON.stringify(map));
}

function autorunStorageKey(extensionId, siteKey) {
    return extensionId + "|||" + siteKey;
}

function renderExtensionsMenu() {
    const menu = document.getElementById("extensions-menu");
    const list = document.getElementById("extensions-list");
    const empty = document.getElementById("extensions-empty");
    if (!menu || !list || !empty) return;

    const extensions = getExtensions();
    const activeSite = getActiveSiteKey();
    list.innerHTML = "";

    if (!extensions.length) {
        empty.classList.remove("hidden");
        return;
    }

    empty.classList.add("hidden");
    extensions.forEach((ext) => {
        const item = document.createElement("div");
        item.className = "extension-item";
        const runBtn = document.createElement("button");
        runBtn.className = "extension-run-btn";
        runBtn.textContent = ext?.name || "Unnamed extension";
        runBtn.onclick = () => runExtension(ext);

        const autorunLabel = document.createElement("label");
        autorunLabel.className = "extension-autorun-toggle";
        const autoToggle = document.createElement("input");
        autoToggle.type = "checkbox";
        autoToggle.disabled = !activeSite;
        autoToggle.checked = isSiteEnabled(ext, activeSite);
        autoToggle.onchange = () => {
            if (!activeSite) return;
            setAutorunState(ext.id, activeSite, autoToggle.checked);
        };
        autorunLabel.append(
            autoToggle,
            document.createTextNode(activeSite ? `Autorun (beta) on ${activeSite} (all directories)` : "Open a site tab to enable autorun")
        );

        item.append(runBtn, autorunLabel);
        list.appendChild(item);
    });
}

function setAutorunState(extensionId, siteKey, shouldAutorun) {
    if (!siteKey) return;
    // Save to dedicated autorunSites map in localStorage
    const map = getAutorunMap();
    const key = autorunStorageKey(extensionId, siteKey);
    if (shouldAutorun) {
        map[key] = true;
    } else {
        delete map[key];
    }
    saveAutorunMap(map);
}

function isSiteEnabled(extension, siteKey) {
    if (!siteKey || !extension?.id) return false;
    return Boolean(getAutorunMap()[autorunStorageKey(extension.id, siteKey)]);
}

function runExtension(extension) {
    const tab = getActiveTab();
    const frameWindow = tab?.frame?.frame?.contentWindow;
    if (!frameWindow || !extension?.code?.trim()) return;

    try {
        frameWindow.eval(extension.code);
    } catch (error) {
        console.warn(`Failed to run extension "${extension.name}":`, error);
    }
}

// Returns the user-friendly URL for the address bar.
// If it's a scramjet proxy URL, shows only the decoded destination.
function getDisplayUrl(rawUrl) {
    if (!rawUrl) return "";
    // Local pages (new tab, settings) show placeholder instead of internal URL
    if (/\/(NT|settings)(\.html)?(\?.*)?$/i.test(rawUrl)) return "";
    const decoded = extractTargetUrl(rawUrl);
    return decoded || rawUrl;
}

function updateAddressFromFrame(tab) {
    if (!tab) return;

    try {
        const frameUrl = tab.frame.frame.contentWindow.location.href;
        if (frameUrl) {
            tab.currentUrl = frameUrl;
            // Cache the decoded hostname so getActiveSiteKey() works even when
            // the menu is closed and the frame URL is no longer readable.
            const resolved = getSiteKeyFromUrl(frameUrl);
            if (resolved) tab.siteKey = resolved;
            if (tab.id === activeTabId) {
                document.getElementById("address-bar").value = getDisplayUrl(frameUrl);
            }
            runAutorunExtensions(frameUrl);
            if (tab.id === activeTabId && extensionsVisible) renderExtensionsMenu();
            return;
        }
    } catch {
        // Fallback to last known URL when frame location is inaccessible.
    }

    if (tab.id === activeTabId && tab.url) {
        document.getElementById("address-bar").value = getDisplayUrl(tab.url);
    }
}

function runAutorunExtensions(currentUrl) {
    if (!currentUrl) return;
    const siteKey = getSiteKeyFromUrl(currentUrl);
    if (!siteKey) return;

    getExtensions()
        .filter((ext) => isSiteEnabled(ext, siteKey))
        .forEach((ext) => runExtension(ext));
}

function getActiveSiteKey() {
    const tab = getActiveTab();
    if (!tab) return "";
    // Use the cached key (set on every load event) so the value is correct
    // whether the extensions menu is open or closed.
    return tab.siteKey || getSiteKeyFromUrl(tab.currentUrl || tab.url);
}

function getSiteKeyFromUrl(rawUrl) {
    const targetUrl = extractTargetUrl(rawUrl);
    if (!targetUrl) return "";

    try {
        return new URL(targetUrl).host.toLowerCase();
    } catch {
        return "";
    }
}

function extractTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";

    const trimmed = rawUrl.trim();

    // ── Scramjet proxy URLs (always check first) ─────────────────────────────
    // href looks like: https://proxyhost/scramjet/<encoded-or-plain-destination>
    // We ONLY want the destination — never return the proxy host.
    const scramjetMatch = trimmed.match(/\/scramjet\/(.+)$/i);
    if (scramjetMatch) {
        const afterPrefix = scramjetMatch[1];

        // Plain URL directly after prefix
        if (/^https?:\/\//i.test(afterPrefix)) return afterPrefix;

        // Percent-encoded: https%3A%2F%2F...
        const encMatch = afterPrefix.match(/^(https?%3A%2F%2F[^\s&#]*)/i);
        if (encMatch) {
            const candidate = safeDecode(encMatch[1]);
            if (/^https?:\/\//i.test(candidate)) return candidate;
        }

        // Decode the whole segment as last resort
        const decoded = safeDecode(afterPrefix);
        if (/^https?:\/\//i.test(decoded)) return decoded;

        // Could not resolve — return empty so we never fall through to the
        // proxy host itself.
        return "";
    }

    // ── Non-proxy plain URL ───────────────────────────────────────────────────
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // ── Percent-encoded standalone URL ───────────────────────────────────────
    const encStandalone = trimmed.match(/^(https?%3A%2F%2F[^\s&#]*)/i);
    if (encStandalone) {
        const candidate = safeDecode(encStandalone[1]);
        if (/^https?:\/\//i.test(candidate)) return candidate;
    }

    return "";
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

// =====================================================
// TAB MANAGEMENT
// =====================================================
function createTab(makeActive = true) {
    const frame = scramjet.createFrame();

    const tab = {
        id: nextTabId++,
        title: "New Tab",
        url: "",
        currentUrl: "",
        siteKey: "",      // decoded hostname, cached on every navigation
        frame,
        loading: false,
        favicon: null,
        navCount: 0
    };

    frame.frame.src = "NT.html";
    frame.frame.addEventListener("load", () => {
        tab.loading = false;
        try {
            const title = frame.frame.contentWindow.document.title;
            if (title) tab.title = title;
        } catch {}
        updateAddressFromFrame(tab);
        updateTabsUI();
    });

    // Poll for URL changes every 5s so autorun fires on every navigation,
    // including SPA soft-navigations that don't trigger a new load event.
    let _lastPolledUrl = "";
    setInterval(() => {
        try {
            const href = frame.frame.contentWindow.location.href;
            if (href && href !== _lastPolledUrl) {
                _lastPolledUrl = href;
                const key = getSiteKeyFromUrl(href);
                if (key) {
                    tab.siteKey = key;
                    tab.currentUrl = href;
                }
                if (tab.id === activeTabId) {
                    document.getElementById("address-bar").value = getDisplayUrl(href);
                }
                runAutorunExtensions(href);
                if (tab.id === activeTabId && extensionsVisible) renderExtensionsMenu();
            }
        } catch { /* cross-origin frame, skip */ }
    }, 5000);

    tabs.push(tab);
    document.getElementById("iframe-container").appendChild(frame.frame);

    if (makeActive) switchTab(tab.id);
}

function switchTab(id) {
    activeTabId = id;
    tabs.forEach((t) => t.frame.frame.classList.toggle("hidden", t.id !== id));
    const active = getActiveTab();
    if (active) {
        document.getElementById("address-bar").value = getDisplayUrl(active.currentUrl || active.url || "");
    }
    if (extensionsVisible) renderExtensionsMenu();
    updateTabsUI();
}

function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    tabs[idx].frame.frame.remove();
    tabs.splice(idx, 1);

    if (tabs.length === 0) createTab(true);
    else switchTab(tabs[Math.max(0, idx - 1)].id);
}

function updateTabsUI() {
    const container = document.getElementById("tabs-container");
    container.innerHTML = "";

    tabs.forEach((tab) => {
        const el = document.createElement("div");
        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;
        el.innerHTML = `<span class="tab-title">${tab.title}</span><span class="tab-close">&times;</span>`;
        el.onclick = () => switchTab(tab.id);
        el.querySelector(".tab-close").onclick = (e) => {
            e.stopPropagation();
            closeTab(tab.id);
        };
        container.appendChild(el);
    });
}

// =====================================================
// NAVIGATION
// =====================================================
function getActiveTab() {
    return tabs.find((t) => t.id === activeTabId);
}

function handleSubmit(url) {
    const tab = getActiveTab();
    if (!tab) return;

    const bar = document.getElementById("address-bar");
    let input = url || bar.value.trim();
    if (!input) return;

    if (!input.startsWith("http") && !input.endsWith(".html")) {
        if (input.includes(".")) input = `https://${input}`;
        else input = SEARCH_URL + encodeURIComponent(input);
    }

    tab.url = input;
    tab.currentUrl = input;
    tab.frame.go(input);
    bar.value = input;
    runAutorunExtensions(input);
}

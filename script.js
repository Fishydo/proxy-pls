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
const INTERNAL_PROTOCOL = "lcc://";
const INTERNAL_PAGES = {
    settings: "settings",
    newtab: "newtab"
};

if (!localStorage.getItem("proxServer")) {
    localStorage.setItem("proxServer", DEFAULT_WISP);
}

// =====================================================
// BROWSER STATE
// =====================================================
if (typeof BareMux === 'undefined') {
    BareMux = { BareMuxConnection: class { constructor() { } setTransport() { } } };
}

let scramjet;
let tabs = [];
let activeTabId = null;
let nextTabId = 1;

// =====================================================
// INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', async function () {
    let basePath = location.pathname.replace(/[^/]*$/, '');
    if (!basePath.endsWith('/')) basePath += '/';
    const { ScramjetController } = $scramjetLoadController();

    scramjet = new ScramjetController({
        prefix: basePath + "scramjet/",
        files: {
            wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
            all: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js",
            sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js"
        }
    });

    try {
        await scramjet.init();

        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.register(basePath + 'sw.js', { scope: basePath });
            await navigator.serviceWorker.ready;
            const wispUrl = localStorage.getItem("proxServer") || DEFAULT_WISP;

            // Try to send to both active registration and controller to be safe
            const sw = reg.active || navigator.serviceWorker.controller;
            if (sw) {
                console.log("Sending config to SW:", wispUrl);
                sw.postMessage({ type: "config", wispurl: wispUrl });
            }

            // Ensure controller also gets it if different
            if (navigator.serviceWorker.controller && navigator.serviceWorker.controller !== sw) {
                navigator.serviceWorker.controller.postMessage({ type: "config", wispurl: wispUrl });
            }

            // Force update to get new SW code if available
            reg.update();

            const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
            await connection.setTransport("https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", [{ wisp: wispUrl }]);
        }

        await initializeBrowser();
    } catch (error) {
        console.error("Failed to initialize proxy UI:", error);
        showErrorMessage("Failed to initialize proxy. Please reload or try another Wisp server.");
    }
});

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
                <div class="tab-strip-left">
                    <div class="tabs" id="tabs-container"></div>
                    <button class="tab-action" id="new-tab-btn" title="New Tab">
                        <i class="fa-solid fa-plus"></i>
                    </button>
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
                    <div class="security-indicator" id="security-indicator">
                        <i class="fa-solid fa-lock"></i>
                    </div>
                    <input class="bar" id="address-bar" autocomplete="off" placeholder="Search Google or type a URL">
                    <div class="omnibox-actions">
                        <button class="omnibox-btn" id="theme-toggle" title="Toggle theme"><i class="fa-solid fa-circle-half-stroke"></i></button>
                    </div>
                </div>
                <div class="toolbar-actions">
                    <button id="devtools-btn" title="DevTools"><i class="fa-solid fa-code"></i></button>
                    <button id="wisp-settings-btn" title="Proxy Settings"><i class="fa-solid fa-gear"></i></button>
                </div>
            </div>
            <div class="loading-bar-container"><div class="loading-bar" id="loading-bar"></div></div>
            <div class="iframe-container" id="iframe-container">
                <div id="loading" class="message-container" style="display: none;">
                    <div class="message-content">
                        <div class="spinner"></div>
                        <h1 id="loading-title">Connecting</h1>
                        <p id="loading-url">Initializing proxy...</p>
                        <button id="skip-btn">Skip</button>
                    </div>
                </div>
                <div id="error" class="message-container" style="display: none;">
                    <div class="message-content">
                        <h1>Connection Error</h1>
                        <p id="error-message">An error occurred.</p>
                    </div>
                </div>
            </div>
        </div>`;

    document.getElementById('back-btn').onclick = () => getActiveTab()?.frame.back();
    document.getElementById('fwd-btn').onclick = () => getActiveTab()?.frame.forward();
    document.getElementById('reload-btn').onclick = () => getActiveTab()?.frame.reload();
    document.getElementById('home-btn-nav').onclick = () => window.location.href = '../index.html';
    document.getElementById('devtools-btn').onclick = toggleDevTools;
    document.getElementById('wisp-settings-btn').onclick = openSettings;
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) themeToggle.onclick = toggleTheme;

    // Skip button logic
    const skipBtn = document.getElementById('skip-btn');
    if (skipBtn) {
        skipBtn.onclick = () => {
            const tab = getActiveTab();
            if (tab) {
                tab.loading = false;
                showIframeLoading(false);
            }
        };
    }

    const addrBar = document.getElementById('address-bar');
    if (addrBar) {
        addrBar.onkeyup = (e) => { if (e.key === 'Enter') handleSubmit(); };
        addrBar.onfocus = () => addrBar.select();
    }

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'navigate') {
            handleSubmit(e.data.url);
            return;
        }
        if (e.data?.type === 'setWisp' && e.data.url) {
            setWisp(e.data.url);
            return;
        }
        if (e.data?.type === 'setTheme' && e.data.theme) {
            setTheme(e.data.theme);
        }
    });

    const newTabButton = document.getElementById('new-tab-btn');
    if (newTabButton) newTabButton.onclick = () => createTab(true);
    window.addEventListener('resize', updateTabsUI);
    createTab(true);
    applyStoredTheme();
    checkHashParameters();
}

// =====================================================
// TAB MANAGEMENT
// =====================================================
function createTab(makeActive = true) {
    const frame = scramjet.createFrame();
    const tab = {
        id: nextTabId++,
        title: "New Tab",
        url: "NT.html",
        frame: frame,
        loading: false,
        favicon: null,
        skipTimeout: null,
        showSkip: false
    };

    frame.frame.src = "NT.html";

    frame.addEventListener("urlchange", (e) => {
        tab.url = e.url;
        tab.loading = true;
        tab.showSkip = false;

        // Show loading screen immediately if this is the active tab
        if (tab.id === activeTabId) {
            showIframeLoading(true, tab.url);
        }

        if (e.url.includes('NT.html')) {
            tab.title = "New Tab";
            tab.url = "";
            tab.favicon = null;
        } else {
            try {
                const urlObj = new URL(e.url);
                tab.title = urlObj.hostname;
                tab.favicon = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
            } catch {
                tab.title = "Browsing";
                tab.favicon = null;
            }
        }
        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 10);

        // Set timeout to show skip button
        if (tab.skipTimeout) clearTimeout(tab.skipTimeout);
        tab.skipTimeout = setTimeout(() => {
            if (tab.loading && tab.id === activeTabId) {
                const skipBtn = document.getElementById('skip-btn');
                if (skipBtn) {
                    skipBtn.style.display = 'inline-block';
                    tab.showSkip = true;
                }
            }
        }, 1000); // 1 second before skip button appears
    });

    frame.frame.addEventListener('load', () => {
        tab.loading = false;
        tab.showSkip = false;
        if (tab.skipTimeout) clearTimeout(tab.skipTimeout);

        if (tab.id === activeTabId) {
            showIframeLoading(false);
        }

        try {
            const title = frame.frame.contentWindow.document.title;
            if (title) tab.title = title;
        } catch { }

        if (frame.frame.contentWindow.location.href.includes('NT.html')) {
            tab.title = "New Tab";
            tab.url = "";
            tab.favicon = null;
        }

        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 100);
    });

    tabs.push(tab);
    document.getElementById("iframe-container").appendChild(frame.frame);
    if (makeActive) switchTab(tab.id);
    return tab;
}

function showIframeLoading(show, url = '') {
    const loader = document.getElementById("loading");
    const title = document.getElementById("loading-title");
    const urlText = document.getElementById("loading-url");
    const skipBtn = document.getElementById("skip-btn");

    if (loader) {
        loader.style.display = show ? "flex" : "none";
        const tab = getActiveTab();
        if (tab) {
            tab.frame.frame.classList.toggle('loading', show);
        }
        if (show) {
            title.textContent = "Connecting";
            urlText.textContent = url || "Loading content...";
            if (skipBtn) skipBtn.style.display = 'none'; // Reset skip button visibility
        } else if (skipBtn) {
            skipBtn.style.display = 'none';
        }
    }
}

function switchTab(tabId) {
    activeTabId = tabId;
    const tab = getActiveTab();

    tabs.forEach(t => t.frame.frame.classList.toggle("hidden", t.id !== tabId));

    // Update loading state for accessibiltiy
    if (tab) {
        showIframeLoading(tab.loading, tab.url);
        const skipBtn = document.getElementById('skip-btn');
        if (tab.loading && skipBtn) {
            skipBtn.style.display = tab.showSkip ? 'inline-block' : 'none';
        }
    }

    updateTabsUI();
    updateAddressBar();
}

function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    if (tabs[idx].skipTimeout) clearTimeout(tabs[idx].skipTimeout);
    tabs[idx].frame.frame.remove();
    tabs.splice(idx, 1);

    if (activeTabId === tabId) {
        if (tabs.length > 0) switchTab(tabs[Math.max(0, idx - 1)].id);
        else createTab(true);
    } else {
        updateTabsUI();
    }
}

function updateTabsUI() {
    const container = document.getElementById("tabs-container");
    if (!container) return;
    container.innerHTML = "";

    tabs.forEach(tab => {
        const el = document.createElement("div");
        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;

        let iconHtml;
        if (tab.loading) {
            iconHtml = `<div class="tab-spinner"></div>`;
        } else if (tab.favicon) {
            iconHtml = `<img src="${tab.favicon}" class="tab-favicon" onerror="this.style.display='none'">`;
        } else {
            iconHtml = ``;
        }

        el.innerHTML = `
            ${iconHtml}
            <span class="tab-title">${tab.title}</span>
            <span class="tab-close">&times;</span>
        `;

        el.onclick = () => switchTab(tab.id);
        el.querySelector(".tab-close").onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
        container.appendChild(el);
    });

    const newTabButton = document.getElementById("new-tab-btn");
    if (!newTabButton) {
        const newBtn = document.createElement("button");
        newBtn.className = "new-tab";
        newBtn.innerHTML = "<i class='fa-solid fa-plus'></i>";
        newBtn.onclick = () => createTab(true);
        container.appendChild(newBtn);
    }

    const availableWidth = container.getBoundingClientRect().width || 0;
    const tabCount = Math.max(tabs.length, 1);
    const maxWidth = 220;
    const minWidth = 120;
    const gap = 6;
    const targetWidth = Math.floor((availableWidth - gap * tabCount) / tabCount);
    const tabWidth = Math.max(minWidth, Math.min(maxWidth, targetWidth));
    container.style.setProperty('--tab-size', `${tabWidth}px`);
}

function updateAddressBar() {
    const bar = document.getElementById("address-bar");
    const tab = getActiveTab();
    if (bar && tab) {
        if (!tab.url || tab.url.includes("NT.html") || tab.url === `${INTERNAL_PROTOCOL}${INTERNAL_PAGES.newtab}`) {
            bar.value = "";
            return;
        }
        bar.value = tab.url;
    }
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

function handleSubmit(url) {
    const tab = getActiveTab();
    if (!tab) return;
    const bar = document.getElementById("address-bar");
    let input = url || bar?.value.trim();
    if (!input) return;

    if (input.startsWith(INTERNAL_PROTOCOL)) {
        handleInternalUrl(input, tab);
        return;
    }

    if (!input.startsWith('http')) {
        if (input.includes('.') && !input.includes(' ')) input = 'https://' + input;
        else input = SEARCH_URL + encodeURIComponent(input);
    }
    tab.frame.go(input);
}

function updateLoadingBar(tab, percent) {
    if (tab.id !== activeTabId) return;
    const bar = document.getElementById("loading-bar");
    if (!bar) return;
    bar.style.width = percent + "%";
    bar.style.opacity = percent === 100 ? "0" : "1";
    if (percent === 100) setTimeout(() => { bar.style.width = "0%"; }, 200);
}

// =====================================================
// SETTINGS & WISP
// =====================================================
function openSettings() {
    const tab = getActiveTab();
    if (!tab) return;
    handleInternalUrl(`${INTERNAL_PROTOCOL}${INTERNAL_PAGES.settings}`, tab);
}

function getStoredWisps() {
    try { return JSON.parse(localStorage.getItem('customWisps') || '[]'); }
    catch { return []; }
}

function setWisp(url) {
    const oldUrl = localStorage.getItem('proxServer');
    if (oldUrl === url) return;
    localStorage.setItem('proxServer', url);

    // Show notification before reload
    if (typeof Notify !== 'undefined' && oldUrl !== url) {
        const serverName = [...WISP_SERVERS, ...getStoredWisps()].find(s => s.url === url)?.name || 'Custom Server';
        Notify.success('Proxy Changed', `Switching to ${serverName}...`);
    }

    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'config', wispurl: url });
    }

    // Small delay to show notification
    setTimeout(() => location.reload(), 600);
}

// =====================================================
// UTILITIES
// =====================================================
function toggleDevTools() {
    const win = getActiveTab()?.frame.frame.contentWindow;
    if (!win) return;
    if (win.eruda) {
        win.eruda.show();
        return;
    }
    const script = win.document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/eruda";
    script.onload = () => { win.eruda.init(); win.eruda.show(); };
    win.document.body.appendChild(script);
}

async function checkHashParameters() {
    if (window.location.hash) {
        const hash = decodeURIComponent(window.location.hash.substring(1));
        if (hash) handleSubmit(hash);
        history.replaceState(null, null, location.pathname);
    }
}

function showErrorMessage(message) {
    const errorEl = document.getElementById("error");
    const errorMessage = document.getElementById("error-message");
    if (!errorEl || !errorMessage) return;
    errorMessage.textContent = message;
    errorEl.style.display = "flex";
    showIframeLoading(false);
}

function handleInternalUrl(input, tab) {
    const page = input.replace(INTERNAL_PROTOCOL, '').toLowerCase();
    if (page === INTERNAL_PAGES.settings) {
        tab.url = `${INTERNAL_PROTOCOL}${INTERNAL_PAGES.settings}`;
        tab.title = "Settings";
        tab.favicon = null;
        tab.loading = false;
        tab.frame.frame.src = "settings.html";
        updateTabsUI();
        updateAddressBar();
        showIframeLoading(false);
        return;
    }

    if (page === INTERNAL_PAGES.newtab) {
        tab.url = `${INTERNAL_PROTOCOL}${INTERNAL_PAGES.newtab}`;
        tab.title = "New Tab";
        tab.favicon = null;
        tab.loading = false;
        tab.frame.frame.src = "NT.html";
        updateTabsUI();
        updateAddressBar();
        showIframeLoading(false);
        return;
    }

    showErrorMessage("Unknown internal page.");
}

function applyStoredTheme() {
    const theme = localStorage.getItem('theme') || 'dark';
    setTheme(theme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.dataset.theme || 'dark';
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
}

function setTheme(theme) {
    const nextTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('theme', nextTheme);
    const themeButtons = document.querySelectorAll('.theme-btn');
    themeButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.theme === nextTheme);
    });
}

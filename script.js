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

if (!localStorage.getItem("proxServer")) {
    localStorage.setItem("proxServer", DEFAULT_WISP);
}

let wispUrl = localStorage.getItem("proxServer") || DEFAULT_WISP;


// =====================================================
// BROWSER STATE
// =====================================================
if (typeof BareMux === 'undefined') {
    BareMux = { BareMuxConnection: class { constructor() {} setTransport() {} } };
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

            reg.update();

            const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");

            await connection.setTransport(
                "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs",
                [{ wisp: wispUrl }]
            );
        }

        await initializeBrowser();

    } catch (error) {

        console.error("Failed to initialize proxy UI:", error);

        showErrorMessage("Failed to initialize proxy. Reload or change Wisp.");

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
</div>

<div class="tab-strip-right">
<button class="tab-action tab-action-new" id="new-tab-btn">
<i class="fa-solid fa-plus"></i>
</button>
</div>

</div>

<div class="toolbar">

<div class="nav-controls">
<button id="back-btn"><i class="fa-solid fa-chevron-left"></i></button>
<button id="fwd-btn"><i class="fa-solid fa-chevron-right"></i></button>
<button id="reload-btn"><i class="fa-solid fa-rotate-right"></i></button>
<button id="home-btn-nav"><i class="fa-solid fa-house"></i></button>
</div>

<div class="address-wrapper">

<div class="security-indicator">
<i class="fa-solid fa-lock"></i>
</div>

<input id="address-bar" autocomplete="off" placeholder="Search or type URL">

<div class="omnibox-actions">

<button id="extensions-btn">
<i class="fa-solid fa-puzzle-piece"></i>
</button>

<button id="theme-toggle">
<i class="fa-solid fa-circle-half-stroke"></i>
</button>

</div>

</div>

</div>

<div class="loading-bar-container">
<div class="loading-bar" id="loading-bar"></div>
</div>

<div class="iframe-container" id="iframe-container"></div>

<div class="extensions-menu hidden" id="extensions-menu">
<div class="extensions-header">Extensions</div>
<div id="extensions-list"></div>
<div id="extensions-empty">No extensions</div>
</div>

</div>
`;

    document.getElementById('back-btn').onclick = () => getActiveTab()?.frame.back();
    document.getElementById('fwd-btn').onclick = () => getActiveTab()?.frame.forward();
    document.getElementById('reload-btn').onclick = () => getActiveTab()?.frame.reload();

    const addrBar = document.getElementById("address-bar");

    addrBar.onkeyup = (e) => {
        if (e.key === "Enter") handleSubmit();
    };

    document.getElementById("new-tab-btn").onclick = () => createTab(true);
    document.getElementById("home-btn-nav").onclick = openHome;
    document.getElementById("theme-toggle").onclick = toggleTheme;
    document.getElementById("extensions-btn").onclick = () => {
        const menu = document.getElementById('extensions-menu');
        menu.classList.toggle('hidden');
        renderExtensionsMenu();
    };

    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.dataset.theme = savedTheme;

    window.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'navigate' && data.url) handleSubmit(data.url);
        if (data.type === 'extensionsUpdated') renderExtensionsMenu();
    });

    window.addEventListener("resize", updateTabsUI);

    createTab(true);

}



function showErrorMessage(message) {
    alert(message);
}

function openHome() {
    handleSubmit('NT.html');
}

function toggleTheme() {
    const themes = ['dark', 'light', 'graphite', 'forest', 'sunset'];
    const current = document.documentElement.dataset.theme || localStorage.getItem('theme') || 'dark';
    const next = themes[(themes.indexOf(current) + 1) % themes.length] || 'dark';
    localStorage.setItem('theme', next);
    document.documentElement.dataset.theme = next;
}

function getExtensions() {
    try {
        return JSON.parse(localStorage.getItem('extensions') || '[]');
    } catch {
        return [];
    }
}

function renderExtensionsMenu() {
    const menu = document.getElementById('extensions-menu');
    const list = document.getElementById('extensions-list');
    const empty = document.getElementById('extensions-empty');
    if (!menu || !list || !empty) return;

    const extensions = getExtensions();
    list.innerHTML = '';

    if (!extensions.length) {
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');
    extensions.forEach(ext => {
        const item = document.createElement('div');
        item.className = 'extension-item';
        item.textContent = ext?.name || 'Unnamed extension';
        list.appendChild(item);
    });
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
        frame: frame,
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

        updateTabsUI();

    });

    tabs.push(tab);

    document.getElementById("iframe-container").appendChild(frame.frame);

    if (makeActive) switchTab(tab.id);

}


function switchTab(id) {

    activeTabId = id;

    tabs.forEach(t => {
        t.frame.frame.classList.toggle("hidden", t.id !== id);
    });

    updateTabsUI();
}


function closeTab(id) {

    const idx = tabs.findIndex(t => t.id === id);

    if (idx === -1) return;

    tabs[idx].frame.frame.remove();

    tabs.splice(idx,1);

    if (tabs.length === 0) createTab(true);
    else switchTab(tabs[Math.max(0, idx-1)].id);

}


function updateTabsUI() {

    const container = document.getElementById("tabs-container");

    container.innerHTML = "";

    tabs.forEach(tab => {

        const el = document.createElement("div");

        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;

        el.innerHTML = `
<span class="tab-title">${tab.title}</span>
<span class="tab-close">&times;</span>
`;

        el.onclick = () => switchTab(tab.id);

        el.querySelector(".tab-close").onclick = (e)=>{
            e.stopPropagation();
            closeTab(tab.id);
        };

        container.appendChild(el);

    });

}


// =====================================================
// NAVIGATION
// =====================================================
function getActiveTab(){
    return tabs.find(t => t.id === activeTabId);
}

function handleSubmit(url){

    const tab = getActiveTab();
    if(!tab) return;

    const bar = document.getElementById("address-bar");

    let input = url || bar.value.trim();

    if(!input) return;

    if(!input.startsWith("http")){

        if(input.includes("."))
            input = "https://" + input;
        else
            input = SEARCH_URL + encodeURIComponent(input);

    }

    tab.frame.go(input);
    bar.value = input;

}

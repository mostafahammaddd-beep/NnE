/* NCLEX-RN — desktop shell (Electron).
   Loads the exact same built web app (dist/) that the Android version uses; nothing in src/ changes. */
const { app, BrowserWindow, shell, session, Menu } = require("electron");
const path = require("path");

const BRAND = "#1CA3BE";
/* Hosts the page may call from file:// . Every one of them gets CORS headers added to its replies (Electron allows ONE
   onHeadersReceived listener, so they all go in this single list). v3.20: the word / sentence translation hosts were missing,
   so the browser blocked every translation reply ("مقدرتش أترجمها" with a perfect connection). */
const CORS_HOSTS = [
  "https://generativelanguage.googleapis.com/*",   // Gemini
  "https://api.groq.com/*",                        // extra free engines (v3.26)
  "https://openrouter.ai/*",
  "https://api.mistral.ai/*",
  "https://translate.googleapis.com/*",            // translation: Google
  "https://translate.google.com/*",
  "https://clients5.google.com/*",
  "https://api.mymemory.translated.net/*",         // translation: fallback provider
];

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: BRAND,
    title: "NCLEX-RN",
    icon: path.join(__dirname, "..", "assets", "icon-only.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  // external links open in the normal browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();                      // also stops a dropped PDF/image from replacing the app window
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // Alt+Left / Alt+Right = back / forward (the app's navigation uses browser history, like the Android back button)
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.alt && input.key === "ArrowLeft" && win.webContents.canGoBack()) { win.webContents.goBack(); e.preventDefault(); }
  });

  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // The page is served from file://, so these APIs must be allowed to answer it (CORS). Only the hosts in CORS_HOSTS are touched.
  session.defaultSession.webRequest.onHeadersReceived({ urls: CORS_HOSTS }, (details, cb) => {
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-allow-/i.test(k)) headers[k] = v;
    }
    headers["Access-Control-Allow-Origin"] = ["*"];
    /* "*" does NOT cover the Authorization header (browser rule), which the extra engines (Groq · OpenRouter · Mistral) use → listed by name */
    headers["Access-Control-Allow-Headers"] = ["authorization, content-type, x-goog-api-key, *"];
    headers["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
    /* a preflight must be answered with a 2xx; some APIs answer OPTIONS with 401/405 */
    if (details.method === "OPTIONS") cb({ responseHeaders: headers, statusLine: "HTTP/1.1 204 No Content" });
    else cb({ responseHeaders: headers });
  });

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

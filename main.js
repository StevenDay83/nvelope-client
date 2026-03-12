const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const path = require('path');
const url = require('url');
const { CacheManager } = require('./cache/cachemanager');
const { EmailCacheHandler } = require('./email/emailcachehandler');
const EmailDatabase = require('better-sqlite3');
const fs = require('fs');

// Initialize Caching
let sqlPath = path.join(__dirname,'profiledata', 'emails.db');

if (fs.existsSync(sqlPath)){
    fs.unlinkSync(sqlPath);
}

let simpleEmailDatabase = new EmailDatabase(path.join(__dirname,'profiledata', 'emails.db'));

let nvCacheManager = new CacheManager();
nvCacheManager.addCacheHandler("emaildbcache", new EmailCacheHandler(simpleEmailDatabase));
nvCacheManager.getCacheHandler("emaildbcache").initializeCacheSync();

let splashScreen, mainWindow, composeWindow;

function startSplash() {
    splashScreen = new BrowserWindow({width: 584, height: 339, frame:false, maxHeight: 584, maxWidth: 565});

    splashScreen.loadURL(url.format({
        pathname: path.join(__dirname, 'frontend', 'splash.html'),
        protocol: 'file',
        slashes: true
    }));

    splashScreen.on('closed', () => {
        splashScreen = null;
    });
}

function startMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1324,
        height: 768,
        maxWidth: 1920,
        maxHeight: 1080
    });

    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'frontend', 'main.html'),
        protocol: 'file',
        slashes: true
    }));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    composeWindow = new BrowserWindow({
        width: 1024,
        height: 600,
        maxWidth: 1920,
        maxHeight: 1080
    });

    composeWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'frontend', 'compose.html'),
        protocol: 'file',
        slashes: true
    }));

    composeWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', startMainWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin'){
        app.quit();
    }
});

app.on('activate', () => {
    if (win === null){
        startSplash();
    }
});
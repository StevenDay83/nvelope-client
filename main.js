const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const path = require('path');
const url = require('url');

let splashScreen, mainWindow;

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
        width: 1280,
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
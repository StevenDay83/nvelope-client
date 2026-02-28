const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const path = require('path');
const url = require('url');

let splashScreen;

function startSplash() {
    splashScreen = new BrowserWindow({width: 584, height: 339, frame:false, maxHeight: 584, maxWidth: 565});

    splashScreen.loadURL(url.format({
        pathname: path.join(__dirname, 'frontend', 'splash.html'),
        protocol: 'file',
        slashes: true
    }));

    splashScreen.on('closed', () => {
        win = null;
    });
}

app.on('ready', startSplash);

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
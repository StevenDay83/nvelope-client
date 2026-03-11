const { CacheHandler } = require('../cache/cachehandler.js');

class EmailCacheHandler extends CacheHandler {
    constructor(emailDB){
        this.emailDatabase = emailDB;
        super();
    }

    initializeCacheSync(){
        initializeTableCmd = `
        CREATE TABLE IF NOT EXISTS nvmessages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_type TEXT,
        
        );
        
        `;
    }
}

module.exports.EmailCacheHandler = EmailCacheHandler;
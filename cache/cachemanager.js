const { CacheHandler } = require('./cachehandler');

class CacheManager {
    constructor(){
        this.cacheManagerTable = {};
        this.expirationLookupTable = {};
    }

    addCacheHandler(cacheHandlerId, cacheHandlerObject){
        if (cacheHandlerId && typeof(cacheHandlerId) === 'string' && 
        cacheHandlerObject && typeof(cacheHandlerObject) === 'object'){
            this.cacheManagerTable[cacheHandlerId] = cacheHandlerObject;
        }
    }

    addSimpleCache(cacheHandlerId){
        if (cacheHandlerId && typeof(cacheHandlerId) === 'string'){
            this.cacheManagerTable[cacheHandlerId] = new CacheHandler();
        }
    }

    removeCacheHandler(cacheHandlerId) {
        if (cacheHandlerId) {
            delete this.cacheManagerTable[cacheHandlerId];
            this.removeCacheExpiration(cacheHandlerId);
        }
    }

    setCacheExpiration(cacheHandlerId, expirationSeconds, intervalSeconds = 60000, cacheOnly = true){
        if (cacheHandlerId && typeof(cacheHandlerId) === 'string' && !isNaN(expirationSeconds) && 
        !isNaN(intervalSeconds)){
            intervalSeconds = intervalSeconds <= 5000 ? 5000 : intervalSeconds;
            let thisCacheHandler = this.cacheManagerTable[cacheHandlerId];

            let intervalId = setInterval(() => {
                let [ cacheValues, cacheKeys ] = thisCacheHandler.getCacheValuesOrderThan(Date.now() - expirationSeconds);

                for (let i = 0; i < cacheKeys.length; i++){
                    let thisCacheKey = cacheKeys[i];

                    if (cacheOnly){
                        this.deleteCacheValueNoPersistence(thisCacheKey);
                    } else {
                        this.deleteCacheValue(thisCacheKey);
                    }
                }
            }, intervalSeconds);

            this.expirationLookupTable[cacheHandlerId] = intervalId;
        }
    }

    removeCacheExpiration(cacheHandlerId){
        clearInterval(this.expirationLookupTable[cacheHandlerId]);
        delete this.expirationLookupTable[cacheHandlerId];
    }
}

module.exports.CacheManager = CacheManager;
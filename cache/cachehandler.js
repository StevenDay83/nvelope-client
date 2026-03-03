const { Cache, NEW_VALUE, CHANGE_VALUE, DELETE_VALUE }= require('./cache.js');

class CacheHandler {
    constructor(thisCache){
        this.cacheObject = thisCache ? thisCache : new Cache();
        this.cacheObject.addAtomicChangeListener("this", this.triggerAtomicCacheAction);
        this.listenerCache = {
            add:{},
            change:{},
            delete:{}
        };
    }

    initializeCacheSync(){
    }

    async initializeCache(callback){
        return new Promise(async (resolve, reject) => {
            callback ? callback(true) : resolve(true);
        });    
    }

    setCacheValueNoPersistence(key, value){
        // Set value in Cache object only
        this.cacheObject.setValue(key, value);
        return true;
    }

    setCacheValue(key, value) {
        // If function is not overridden, acts like "...NoPersistence"
        this.setCacheValueNoPersistence(key, value);
    }

    async getCacheValue(key, callback) {
        return new Promise(async (resolve, reject) => {
            callback ? callback(this.cacheObject.getValue(key)) : resolve(this.cacheObject.getValue(key));
        });
    }

    getCacheValueNoPersistence(key) {
        return this.cacheObject.getValue(key);
    }

    getCacheValueByAttributes(searchAttributes) {}

    getCacheValuesOrderThan(timeValue) {
        let cacheArray = [];

        if (timeValue && !isNaN(timeValue) && timeValue > Date.now()){
            let cacheKeys = Object.keys(this.cacheObject.cacheTable);

            for (let i = 0; i < cacheKeys.length; i++){
                let thisTimeStamp = this.cacheObject.getTimeStamp(cacheKeys[i]);

                if (thisTimeStamp && thisTimeStamp < timeValue){
                    cacheArray.push(this.cacheObject.getValue(cacheKeys[i]));
                }
            }
        }

        return cacheArray;
    }

    getCacheValuesNewerThan(timeValue) {
        let cacheArray = [];

        if (timeValue && !isNaN(timeValue) && timeValue > Date.now()){
            let cacheKeys = Object.keys(this.cacheObject.cacheTable);

            for (let i = 0; i < cacheKeys.length; i++){
                let thisTimeStamp = this.cacheObject.getTimeStamp(cacheKeys[i]);

                if (thisTimeStamp && thisTimeStamp >= timeValue){
                    cacheArray.push(this.cacheObject.getValue(cacheKeys[i]));
                }
            }
        }

        return cacheArray;
    }

    deleteCacheValue(key) {
        return this.cacheObject.deleteValue(key);
    }

    addCacheListenerOnAddCache(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerCache.add[listenerId] = callback;
        }
    }

    addCacheListenerOnRemoveCache(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerCache.delete[listenerId] = callback;
        }
    }

    addCacheListenerOnAtomicChangeCache(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerCache.change[listenerId] = callback;
        }
    }

    removeCacheListenerOnAddCache(listenerId){
        delete this.listenerCache.add[listenerId];
    }

    removeCacheListenerOnRemoveCache(listenerId){
        delete this.listenerCache.delete[listenerId];

    }

    removeCacheListenerOnAtomicChangeCache(listenerId){
        delete this.listenerCache.change[listenerId];
    }

    triggerAtomicCacheAction(action, value){
        let listenerFunctions;
        if (action == NEW_VALUE) {
            listenerFunctions = Object.values(this.listenerCache.add);
        } else if (action == CHANGE_VALUE){
            listenerFunctions = Object.values(this.listenerCache.change);
        } else if (action == DELETE_VALUE){
            listenerFunctions = Object.values(this.listenerCache.delete);
        }

        if (listenerFunctions){
            for (let i = 0; i < listenerFunctions.length; i++){
                let thisCallback = listenerFunctions[i];
                thisCallback(value);
            }
        }
    }
}

module.exports.CacheHandler = CacheHandler;
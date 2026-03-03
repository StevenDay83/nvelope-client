const NEW_VALUE = "NEW";
const CHANGE_VALUE = "CHANGE";
const DELETE_VALUE = "DELETE"

class Cache {
    constructor(){
        this.cacheTable = {};
        this.atomicChangeListenerTable = {};
    }

    clearCache(){
        this.cacheTable = {};
    }

    setValue(key, value){
        let action;
        if (key && typeof(key) === 'string'){
            action = this.cacheTable[key] ? CHANGE_VALUE : NEW_VALUE;
            let newCacheValue =  {
                value:value,
                timeStamp:Date.now()
            };
            this.cacheTable[key] = newCacheValue;
            this.triggerAtomicChange(action, newCacheValue);
        }
    }

    getValue(key) {
        let thisValue;
        
        if (key && typeof(key) === 'string'){
            thisValue = this.cacheTable[key] ? this.cacheTable[key].value : undefined;
        }

        return thisValue;
    }

    getTimeStamp(key) {
        let thisTimeStamp;
        
        if (key && typeof(key) === 'string'){
            thisTimeStamp = this.cacheTable[key] ? this.cacheTable[key].timeStamp : undefined;
        }

        return thisTimeStamp;
    }

    deleteValue(key) {
        let success = false;

        if (key && typeof(key) === 'string'){
            let deletedCacheValue = JSON.parse(JSON.stringify(this.cacheTable[key])); // Make a copy
            delete this.cacheTable[key];
            this.triggerAtomicChange(DELETE_VALUE, deletedCacheValue);
        }

        return success;
    }

    resetCacheTimeStamps() {
        let cacheKeys = Object.keys(this.cacheTable);

        for (let i = 0; i < cacheKeys.length; i++){
            this.cacheTable[cacheKeys[i]].timeStamp = Date.now();
        }
    }

    triggerAtomicChange(action, value){
        let listenerFunctions = Object.values(this.atomicChangeListenerTable);

        for (let i = 0; i < listenerFunctions.length; i++){
            let callback = listenerFunctions[i];
            callback(action, value);
        }
    }

    addAtomicChangeListener(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.atomicChangeListenerTable[listenerId] = callback;
        }
    }

    removeAtomicChangeListeneR(listenerId) {
        if (listenerId && typeof(listenerId)){
            delete this.atomicChangeListenerTable[listenerId];
        }
    }


}

module.exports.Cache = Cache;
module.exports.NEW_VALUE = NEW_VALUE;
module.exports.CHANGE_VALUE = CHANGE_VALUE;
module.exports.DELETE_VALUE = DELETE_VALUE;
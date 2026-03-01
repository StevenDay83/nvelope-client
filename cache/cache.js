class Cache {
    constructor(){
        this.cacheTable = {};
    }

    clearCache(){
        this.cacheTable = {};
    }

    setValue(key, value){
        if (key && typeof(key) === 'string'){
            this.cacheTable[key] = {
                value:value,
                timeStamp:Date.now()
            }
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
            delete this.cacheTable[key];
        }

        return success;
    }

    resetCacheTimeStamps() {
        let cacheKeys = Object.keys(this.cacheTable);

        for (let i = 0; i < cacheKeys.length; i++){
            this.cacheTable[cacheKeys[i]].timeStamp = Date.now();
        }
    }
}

module.exports.Cache = Cache;
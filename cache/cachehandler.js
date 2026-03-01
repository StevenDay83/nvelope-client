const Cache = require('./cache.js');

class CacheHandler {
    constructor(){
        this.cacheObject = new Cache();
    }

    initializeCache(){
        this.cacheObject = new Cache();
    }

    setCacheValueNoPersistence(key, value){
        // Set value in Cache object only
        this.cacheObject.setValue(key, value);
    }

    setCacheValue(key, value) {
        // If function is not overridden, acts like "...NoPersistence"
        this.setCacheValueNoPersistence(key, value);
    }

    getCacheValue(key) {
        this.cacheObject.getValue(key);
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
}
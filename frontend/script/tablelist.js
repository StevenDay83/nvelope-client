class TableList {
    constructor (id){
        this.id = id;
        this.headings = [];
        this.tableContent = {};
    }

    setHeaderWithAttributes(headerName, attributes, place){
        let thisHeader = {};
        if (headerName && typeof(headerName) === 'string'){
            thisHeader.label = headerName;

            if (attributes && typeof(attributes) === 'object'){
                thisHeader.attributes = attributes;
            }

            this.headings.splice(place ? place : this.headings.length, 0, thisHeader);
        }
    }

    addHeader(headerName, attributes){
        this.setHeaderWithAttributes(headerName, attributes);
    }
}

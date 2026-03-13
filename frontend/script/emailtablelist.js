class EmailTableList {
    constructor (id){
        this.id = id;

        this.headings = [
            {name:'starred', label:'⭐',defaultwidth:'1'},
            {name:'messagetype', label:'📧', hidden:true},
            {name:'from', label:'From'},
            {name:'subject', label:'Subject', defaultwidth:'50'},
            {name:'date', label:'Date', defaultwidth:'25'}
        ];
        this.objectMap = {};
        this.tableElement = document.createElement("table", "_emailtablelist");
        this.tableHeaderElement = document.createElement("thead", "_emailtableheaders");
        this.tableContentElements = document.createElement("tbody", "_emailtablecontent");
        document.getElementById(this.id).appendChild(this.tableElement);
        this.tableContent = [];
        this.selections = [];
        this.listenerTable = {"selection":{},"remove":{}};
    }

    renderTable(){
        this.tableElement.className = 'table table-sm table-hover email-table unselectable';
        this.tableElement.appendChild(this.tableHeaderElement);
        this.tableElement.appendChild(this.tableContentElements);

        this.renderHeaders();
        this.renderContent();
    }

    renderHeaders() {
        let headerHTML = '';
        headerHTML += '<tr>';
        let headerList = '';
        for (let i = 0; i < this.headings.length; i++){
            let thisHeader = this.headings[i];

            if (!thisHeader.hidden){
                headerList += '<th scope="col" ';
                headerList += thisHeader.defaultwidth ? 'style="width:' + thisHeader.defaultwidth + '%">': '>';
                headerList += thisHeader.label + '</th>';
            }
        }

        headerHTML += headerList;
        headerHTML += '</tr>';

        this.tableHeaderElement.innerHTML = headerHTML;
    }

    renderContent() {
        this.tableContentElements.innerHTML = '';

        for (let i = 0; i < this.tableContent.length; i++){
            let contentRow = document.createElement("tr");
            let thisTableObject = this.tableContent[i];
            contentRow.className = (this.selections.indexOf(i) > -1 ? 'table-active' : '') + (thisTableObject["read"] ? '' : ' fw-semibold');
            // contentRow.innerHTML += this.selections.indexOf(i) > -1 ? '<tr class="table-active">' : '<tr>';

            for (let k = 0; k < this.headings.length; k++){
                let thisHeadingObject = this.headings[k];
                if (!thisHeadingObject.hidden){
                    let thisHeadingName = thisHeadingObject.name;
                    let thisContentCol = document.createElement("td");
                    // thisContentCol.setAttribute('id', this.id + ":" + thisHeadingName + ":" + i);
                    thisContentCol.setAttribute('row', i);
                    thisContentCol.innerHTML = thisTableObject[this.objectMap[thisHeadingName]];
                    // contentRow.innerHTML += '<td>' + thisTableObject[this.objectMap[thisHeadingName]] + '</td>';
                    contentRow.appendChild(thisContentCol);
                }
            }
            // contentHTML += '</tr>'
            this.tableContentElements.appendChild(contentRow);
            // this.tableContentElements.addElement(contentRow);
            // contentRow.addEventListener('click', this.clickedRow);
            
            this.tableElement.focus

            contentRow.addEventListener('click', (clickedEvent) => {
                let clickedElement = clickedEvent.target;
                let selectedRow = parseInt(clickedElement.getAttribute('row'));

                if (clickedEvent.ctrlKey) {
                    if (this.selections.indexOf(selectedRow) == -1) {
                        this.selections.push(selectedRow);
                    } else {
                        // this.selections.splice(selectedRow, 1);
                        this.selections.splice(this.selections.indexOf(selectedRow), 1);
                    }
                } else if (clickedEvent.shiftKey) {
                    if (this.selections.length == 0) {
                        this.selections.push(selectedRow);
                    } else {
                        let startingPos = getLowestArrayValue(this.selections);
                        this.selections = [];
                        for (let i = startingPos; startingPos < selectedRow ? i <= selectedRow : i >= selectedRow; startingPos < selectedRow ? i++ : i--) {
                            this.selections.push(i);
                        }
                    }
                } else {
                    if (selectedRow != undefined) {
                        this.selections = [selectedRow];
                    }
                }
                // console.log(clickedElement.getAttribute('row'));
                // console.log(clickedElement.className);
                // console.log(clickedEvent.shiftKey);

                this.renderContent();
                this.triggerSelectionChange();
            });
        }

        // this.tableContentElements.innerHTML += contentRow.innerHTML;
    }

    mapObjectToHeadings(objectMap){
        if (objectMap && typeof(objectMap) === 'object'){
            this.objectMap = objectMap;
        }
    }

    addElement(elementObject, place){
        this.tableContent.splice(place > -1 ? place : this.tableContent.length, 0, elementObject);

        this.renderContent();
    }

    removeElements(places){
        if (places && Array.isArray(places)){
            let objectList = [];
            for (let i = 0; i < places.length; i++){
                let thisPlace = places[i];
                if (thisPlace > -1 && thisPlace < this.tableContent.length){
                    objectList.push(this.tableContent[thisPlace]);
                }
            }

            for (let j = 0; j < objectList.length; j++){
                let thisObject = objectList[j];
                let objectPlace = this.tableContent.indexOf(thisObject);

                if (objectPlace > -1){
                    this.tableContent.splice(objectPlace, 1);
                }
            }
        }
        this.renderContent();
    }

    requestRemoveSelections(){
        let removalChange = {
            selectionList:this.getSelectionFromList(),
            selectionsIndex:this.selections
        };
        this.triggerRemoveChange(removalChange);
    }

    importBulkElements(elementArray, append = false) {
        if (elementArray && Array.isArray(elementArray)) {
            this.tableContent = append ? this.tableContent : [];

            for (let i = 0; i < elementArray.length; i++){
                this.addElement(elementArray[i]);
            }
        }
    }

    addRemoveListener(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerTable["remove"][listenerId] = callback;
        }
    }

    removeRemoveListener(listenerId){
        if (listenerId && typeof(listenerId) === 'string'){
            delete this.listenerTable["remove"][listenerId];
        }
    }

    addSelectionListener(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerTable["selection"][listenerId] = callback;
        }
    }

    removeSelectionListener(listenerId){
        if (listenerId && typeof(listenerId) === 'string'){
            delete this.listenerTable["selection"][listenerId];
        }
    }

    getSelectionFromList(){
        let selectionObjects = [];

        for (let i = 0; i < this.selections.length; i++){
            let selectionIndex = this.selections[i];

            selectionObjects.push(this.tableContent[selectionIndex]);
        }

        return selectionObjects;
    }

    triggerSelectionChange(){
        let selectionChange = {
            selectionList:this.getSelectionFromList(),
            selectionsIndex:this.selections
        };

        let callbackList = Object.values(this.listenerTable["selection"]);

        for (let i = 0; i < callbackList.length; i++){
            let thisCallback = callbackList[i];

            thisCallback(selectionChange);
        }
    }

    triggerRemoveChange(removalChange){
        let callbackList = Object.values(this.listenerTable["remove"]);

        for (let i = 0; i < callbackList.length; i++){
            let thisCallback = callbackList[i];

            thisCallback(removalChange);
        }
    }
}

function getLowestArrayValue(numArray){
    let lowestNumber;

    for (let i = 0; i < numArray.length; i++){
        if (i == 0){
            lowestNumber = numArray[0]
        }

        if (numArray[i] < lowestNumber){
            lowestNumber = numArray[i];
        }
    }

    return lowestNumber;
}
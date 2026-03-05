class EmailTableList {
    constructor (id){
        this.id = id;

        this.headings = [
            {name:'starred', label:'⭐',defaultwidth:'1'},
            {name:'messagetype', label:'📧', hidden:true},
            {name:'from', label:'From'},
            {name:'subject', label:'Subject', defaultwidth:'50'},
            {name:'date', label:'Date', defaultwidth:'20'}
        ];
        this.objectMap = {};
        this.tableElement = document.createElement("table", "_emailtablelist");
        this.tableHeaderElement = document.createElement("thead", "_emailtableheaders");
        this.tableContentElements = document.createElement("tbody", "_emailtablecontent");
        document.getElementById(this.id).appendChild(this.tableElement);
        this.tableContent = [];
    }

    renderTable(){
        this.tableElement.className = 'table table-sm table-hover';
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
        let contentHTML = '';

        for (let i = 0; i < this.tableContent.length; i++){
            contentHTML += '<tr>'
            let thisTableObject = this.tableContent[i];

            for (let k = 0; k < this.headings.length; k++){
                let thisHeadingObject = this.headings[k];
                if (!thisHeadingObject.hidden){
                    let thisHeadingName = thisHeadingObject.name;
    
                    contentHTML += '<td>' + thisTableObject[this.objectMap[thisHeadingName]] + '</td>';
                }
            }
            contentHTML += '</tr>'
        }

        this.tableContentElements.innerHTML = contentHTML;
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
}

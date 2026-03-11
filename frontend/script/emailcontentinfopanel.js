class EmailContentInfoPanel {
    constructor(id){
        this.parentElement = document.getElementById(id);

        this.infoPanelTable = {
            to:[],
            from:'',
            subjectLine:'',
            fav:false,
            timeStamp:-1
        };
        this.tableElement = document.createElement('table');
        this.tableElement.className = 'table table-sm table-borderless table-light';

        this.parentElement.appendChild(this.tableElement);
    }

    setPanelInfo(emailObject) {
        if (emailObject && typeof(emailObject) === 'object'){
            this.clearPanelInfo();

            this.infoPanelTable.to = emailObject.to ? emailObject.to : '';
            this.infoPanelTable.from = emailObject.from ? emailObject.from : '';
            this.infoPanelTable.subjectLine = emailObject.subjectLine ? emailObject.subjectLine : '';
            this.infoPanelTable.fav = emailObject.fav != undefined ? emailObject.fav : false;
            this.infoPanelTable.timeStamp = emailObject.timeStamp != undefined && !isNaN(emailObject.timeStamp) ? emailObject.timeStamp : -1;
        }
    }

    clearPanelInfo(){
        this.infoPanelTable = {
            to:[],
            from:'',
            subjectLine:'',
            fav:false,
            timeStamp:0
        };
    }

    render(){
        this.tableElement.innerHTML = '';
        this.renderSubjectLine();
        this.renderFromLine();
        this.renderToLine();
    }

    renderSubjectLine(){
        let subjectLineRow = document.createElement('tr');
        let subjectLineCol = document.createElement('td');

        subjectLineRow.appendChild(subjectLineCol);
        subjectLineCol.innerHTML = '<h4>' +  this.infoPanelTable.subjectLine + '</h4>';

        this.tableElement.appendChild(subjectLineRow);
    }

    renderFromLine(){
        let fromLineRow = document.createElement('tr');
        let fromLineCol = document.createElement('td');

        fromLineRow.appendChild(fromLineCol);
        fromLineCol.innerHTML = '<span class="small">From: ' + this.infoPanelTable.from + '</span>';
        // fromLineCol.innerHTML = '<h4>' +  this.infoPanelTable.subjectLine + '</h4>';

        this.tableElement.appendChild(fromLineRow);
    }

    renderToLine(){
        let toLineRow = document.createElement('tr');
        let toLineCol = document.createElement('td');

        toLineRow.appendChild(toLineCol);
        toLineCol.innerHTML = '<span class="small">To: ' + this.infoPanelTable.to + '</span>';

        this.tableElement.appendChild(toLineRow);
    }
}
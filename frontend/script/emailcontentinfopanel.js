class EmailContentInfoPanel {
    constructor(){
        this.infoPanelTable = {
            to:[],
            from:'',
            subjectLine:'',
            fav:false,
            timeStamp:-1
        };
        this.tableElement = document.createElement('table');
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

    }
}
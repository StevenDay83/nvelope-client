class EmailContentRenderPane {
    constructor(id){
        this.parentElement = document.getElementById(id);
        this.contentData = {
            plain:'',
            md:'',
            html:''
        };
    }

    render(contentType = 'plain'){
        this.parentElement.innerHTML = '';

        let contentElement = document.createElement("p");
        let tableElement = document.createElement("table");
        let tableRow = document.createElement("tr");
        let tableCol = document.createElement("td");

        tableElement.className = 'table table-sm table-borderless table-wrapper';
        tableElement.appendChild(tableRow);

        let contentData = this.contentData[contentType] ? this.contentData[contentType] : '';

        if (contentType == 'plain') {
            contentElement.className = 'font-monospace';
            contentElement.innerText = contentData;
        } else if (contentType == 'md'){
            // TBD: Add markdown to HTML conversion, safe
        } else if (contentType == 'html') {
            // TBD: Add safe HTML
        }

        tableCol.appendChild(contentElement);
        tableRow.appendChild(tableCol);

        this.parentElement.appendChild(tableElement);
    }

    setContentData(contentType = 'plain', textData){
        if (contentType && typeof(contentType) === 'string' && textData && typeof(textData) === 'string'){
            this.contentData[contentType] = textData;
        }
    }

    resetContentData(){
        this.contentData = {
            "plain":'',
            "md":'',
            "html":''
        };
    }
}
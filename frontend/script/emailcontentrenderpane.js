class EmailContentRenderPane {
    constructor(){
        this.contentData = {
            plain:'',
            md:'',
            html:''
        };
        this.contentElement = document.createElement("span");
    }

    render(contentType = 'plain'){
        let contentData = this.contentData[contentType] ? this.contentData[contentType] : '';

        if (contentType == 'plain') {
            this.contentElement.className = 'font-monospace';
            this.contentElement.innerText = contentData;
        } else if (contentType == 'md'){
            // TBD: Add markdown to HTML conversion, safe
        } else if (contentType == 'html') {
            // TBD: Add safe HTML
        }
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
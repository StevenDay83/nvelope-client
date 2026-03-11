class EmailViewToolBar {
    constructor(id){
        this.parentElement = document.getElementById(id)
        
        // this.divFluid = document.createElement('div');
        // this.divFluid.className = 'container-fluid';

        // this.divInsideRow = document.createElement('div');
        // this.divInsideRow.className = 'row';
        
        // this.divInsideCol = document.createElement('div');
        // this.divInsideCol.className = 'col';

        this.divFluid = document.createElement('table');
        this.divFluid.className = 'table table-secondary';

        this.divInsideRow = document.createElement('tr');
        // this.divInsideRow.className = 'row';
        
        this.divInsideCol = document.createElement('td');
        // this.divInsideCol.className = 'col';

        this.parentElement.appendChild(this.divFluid);
        this.divFluid.appendChild(this.divInsideRow);
        this.divInsideRow.appendChild(this.divInsideCol);
        
        let replyButtonElement = document.createElement("button");
        let replyAllButtonElement = document.createElement("button");
        let forwardButtonElement = document.createElement("button");
        let deleteButtonElement= document.createElement("button");

        replyButtonElement.setAttribute('id', "_emailToolBarReply");
        replyAllButtonElement.setAttribute('id', "_emailToolBarReplyAll");
        forwardButtonElement.setAttribute('id', "_emailToolBarForward");
        deleteButtonElement.setAttribute('id', "_emailToolBarDelete");

        this.divInsideCol.appendChild(replyButtonElement);
        this.divInsideCol.appendChild(replyAllButtonElement);
        this.divInsideCol.appendChild(forwardButtonElement);
        this.divInsideCol.appendChild(deleteButtonElement);

        this.replyButton = new nVelopeButton(replyButtonElement.getAttribute('id'));
        this.replyAllButton = new nVelopeButton(replyAllButtonElement.getAttribute('id'));
        this.forwardButton = new nVelopeButton(forwardButtonElement.getAttribute('id'));
        this.deleteButton = new nVelopeButton(deleteButtonElement.getAttribute('id'));

        this.replyButton.setButtonLabel(REPLY);
        this.replyButton.setBtnStyle('btn-light');
        this.replyButton.buttonElement.className += ' m-1';

        this.replyAllButton.setButtonLabel(REPLY + REPLY);
        this.replyAllButton.setBtnStyle('btn-light');
        this.replyAllButton.buttonElement.className += ' m-1';

        this.forwardButton.setButtonLabel(FORWARD);
        this.forwardButton.setBtnStyle('btn-light');
        this.forwardButton.buttonElement.className += ' m-1';

        this.deleteButton.setButtonLabel(DELETE);
        this.deleteButton.setBtnStyle('btn-light');
        this.deleteButton.buttonElement.className += ' m-1';

    }
}
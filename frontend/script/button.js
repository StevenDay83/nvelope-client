class nVelopeButton {
    constructor(elementId){
        this.buttonElement = document.getElementById(elementId);
        this.listenerTable = {"clicked":{}};

        this.setStyleSecondary();

        this.buttonElement.onclick = (clickedEvent) => {
            this.triggerClickedEvent();
        };
    }

    setButtonLabel(htmlLabel){
        this.buttonElement.innerHTML = htmlLabel;
    }

    setStylePrimary() {
        // this.buttonElement.className = 'btn btn-primary';
        this.setBtnStyle('btn-primary');
    }

    setStyleSecondary() {
        // this.buttonElement.className = 'btn btn-primary';
        this.setBtnStyle('btn-secondary');
    }

    setBtnStyle(styleButtonClass) {
        this.buttonElement.className = 'btn ' + styleButtonClass;
    }

    addClickedListener(listenerId, callback){
        if (listenerId && typeof(listenerId) === 'string' && callback && typeof(callback) === 'function'){
            this.listenerTable["clicked"][listenerId] = callback;
        }
    }

    removeClickedListener(listenerId){
        if (listenerId && typeof(listenerId) === 'string'){
            delete this.listenerTable["clicked"][listenerId];
        }
    }

    triggerClickedEvent(){
        let callbackList = Object.values(this.listenerTable["clicked"]);

        for (let i = 0; i < callbackList.length; i++){
            let thisCallback = callbackList[i];

            thisCallback();
        }
    }

    show(){
        this.buttonElement.hidden = false;
    }
}
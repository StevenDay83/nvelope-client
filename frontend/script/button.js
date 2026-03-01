class nVelopeButton {
    constructor(elementId){
        this.buttonElement = document.getElementById(elementId);
        this.setStyleSecondary();
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

    show(){
        this.buttonElement.hidden = false;
    }
}
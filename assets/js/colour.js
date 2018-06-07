function MouseOver(){
                setInterval(function(){ 
                    var red = Math.round(Math.random() * 255);
                    var green = Math.round(Math.random() *255);
                    var blue = Math.round(Math.random() *255);

                    var bg = "padding: 0; background: rgb("+red+","+green+","+blue+");";
                    var element = document.getElementById("header-image");
                    element.style = bg;}, 100); 
}




function MouseOut(){
  document.getElementById("header-image").style = "padding: 0; background: black;"
}
       
     
     

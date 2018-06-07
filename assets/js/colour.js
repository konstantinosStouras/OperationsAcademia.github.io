                function MouseOver(){
                setInterval(function(){ 
                    var red = Math.round(Math.random() * 255);
                    var green = Math.round(Math.random() *255);
                    var blue = Math.round(Math.random() *255);

                    var bg = "padding: 0; background: rgb("+red+","+green+","+blue+");";
                    var element = document.getElementById("header");
                    element.style = bg;}, 0); 
                }




            function MouseOut(){
                document.getElementById("header").style = "padding: 0; background: black;"
            }
       
     
     

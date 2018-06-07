                function MouseOver(){
                setInterval(function(){ 
                    var red = Math.round(Math.random() * 255);
                    var green = Math.round(Math.random() *255);
                    var blue = Math.round(Math.random() *255);

                    var bg = "padding: 0; background: rgb("+red+","+green+","+blue+");";
                    var element = document.getElementById("foot-img");
                    element.style = bg;},1000); 
                }




            function MouseOut(){
                document.getElementById("foot-img").style = "padding: 0; background: black;"
            }
       
     
     
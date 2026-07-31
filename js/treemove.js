window.addEventListener('mousemove', parallax);
function parallax(e){
    document.querySelectorAll('.object').forEach(function(move){
        let moving_value = move.getAttribute('data-value');
        let x = (e.clientX * moving_value) /250 ;
        let y = (e.clientY * moving_value) /250 ;
        move.style.transform = `translate(${x}px, ${y}px)`;
    });
}

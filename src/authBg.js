// A belépő oldal háttere (sötét, szintvonalas térkép, rajta kirajzolódó útvonal) a többi
// fiók-oldalra is: elfelejtett jelszó, meghívó, e-mail-megerősítés. A .bg elemet tölti ki.
(function () {
  var bg = document.querySelector(".bg");
  if (!bg) return;
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var seed = 7, rnd = function () { return (seed = (seed * 16807) % 2147483647) / 2147483647; };
  var hills = [[330, 300, 250], [1250, 640, 300], [820, 820, 200], [1380, 140, 190], [760, 120, 170], [120, 620, 180]];
  var contours = "";
  hills.forEach(function (h) {
    var ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    for (var r = h[2]; r > 30; r -= 34) {
      var d = "";
      for (var k = 0; k <= 48; k++) {
        var a = (k / 48) * Math.PI * 2;
        var rr = r * (1 + 0.16 * Math.sin(2 * a + ph[0]) + 0.09 * Math.sin(3 * a + ph[1]) + 0.05 * Math.sin(5 * a + ph[2]));
        d += (k ? "L" : "M") + (h[0] + rr * Math.cos(a)).toFixed(1) + " " + (h[1] + rr * 0.8 * Math.sin(a)).toFixed(1);
      }
      contours += '<path d="' + d + 'Z" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.2"/>';
    }
  });
  var R = "M110 800 C 260 900, 420 760, 600 840 S 900 940, 1080 840 S 1330 760, 1400 620 S 1500 420, 1420 300 S 1300 150, 1180 130";
  var T = 'dur="11s" repeatCount="indefinite"';
  bg.innerHTML = '<svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%">'
    + contours
    + '<path id="abRoute" d="' + R + '" fill="none" stroke="rgba(252,76,2,0.16)" stroke-width="5" stroke-linecap="round"/>'
    + '<path d="' + R + '" pathLength="1" fill="none" stroke="#ff6a3d" stroke-width="5" stroke-linecap="round" stroke-dasharray="1" stroke-dashoffset="1" style="filter:drop-shadow(0 0 8px rgba(252,76,2,.55))">'
    + '<animate attributeName="stroke-dashoffset" ' + T + ' values="1;0;0;0" keyTimes="0;0.68;0.9;1" calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;0 0 1 1"/>'
    + '<animate attributeName="opacity" ' + T + ' values="1;1;0" keyTimes="0;0.9;1"/></path>'
    + '<circle cx="110" cy="800" r="9" fill="#22c55e" stroke="#fff" stroke-width="3"/>'
    + '<g><circle r="9" fill="#ff6a3d" stroke="#fff" stroke-width="3"/>'
    + '<animateMotion ' + T + ' keyPoints="0;1;1;1" keyTimes="0;0.68;0.9;1" calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;0 0 1 1"><mpath href="#abRoute"/></animateMotion>'
    + '<animate attributeName="opacity" ' + T + ' values="1;1;0" keyTimes="0;0.9;1"/></g></svg>';
  var st = document.createElement("style");
  st.textContent = "body{background:#10151a!important}"
    + ".bg{background:#10151a!important;filter:none!important;transform:none!important}"
    + ".bg::after{content:'';position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,rgba(16,21,26,0) 0%,rgba(16,21,26,.6) 75%,rgba(16,21,26,.9) 100%)}"
    + "@media (max-aspect-ratio:4/5){body{padding-top:calc(8vh + env(safe-area-inset-top))!important}}"
    + (calm ? "" : ".card{animation:abRise .6s cubic-bezier(.2,.8,.2,1) both}@keyframes abRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}");
  document.head.appendChild(st);
  if (calm) { try { var svg = bg.querySelector("svg"); svg.pauseAnimations(); svg.setCurrentTime(8.5); } catch (e) { /* álló kép */ } }
})();

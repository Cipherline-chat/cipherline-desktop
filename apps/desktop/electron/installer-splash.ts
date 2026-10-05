// Installer splash window — the Discord-style "no-prompt install" experience.
//
// This is NOT the OS installer (NSIS / DMG / AppImage can't render HTML). It's
// a frameless Electron window the main process opens on first install OR after
// an update (see main.ts version-file gate). It plays the "Key Spinner"
// working animation while real startup work runs, drives a REAL progress bar
// off init milestones, then transitions to the "You're in." completion state.
// One second after completion the main process shows the real app window and
// closes this one.
//
// Ported by hand from the two design-system mockups in
// Redesign/Installer/*.dc.html — the `x-dc`/DCLogic prototype framework those
// use isn't runnable here, so the markup, keyframes, and the working→done
// state machine are reproduced as a standalone document. Design tokens are
// inlined from apps/desktop/src/index.css (:root) since the splash loads as a
// self-contained data: URL with no access to the app's stylesheet.
//
// The main process drives it via webContents.executeJavaScript():
//   window.clProgress(pct)        — set the real target % (bar eases toward it)
//   window.clStatus(text)         — optional status-line override
//   window.clComplete()           — fill to 100%, fire the "You're in." state
//
// The top title bar is `-webkit-app-region: drag` so the frameless window can
// be moved around the screen.

export function installerSplashHtml(version: string, isUpdate = false): string {
  const safeVersion = String(version).replace(/[^0-9A-Za-z.\-+]/g, '');

  // Copy is tailored for a fresh install vs. an update (the caller decides
  // based on whether a version marker already existed). All escapes are
  // double-backslashed so the emitted <script> contains real \\u sequences.
  const verbing = isUpdate ? 'updating' : 'installing';
  const headline = isUpdate ? 'All updated.' : 'You&rsquo;re in.';
  const defaultSub = isUpdate ? 'you&rsquo;re all set.' : 'your community is waiting.';
  const successLine = isUpdate ? 'updated \\u00b7 let\\u2019s go' : 'all set \\u00b7 let\\u2019s go';
  const subsJs = isUpdate
    ? "['you\\u2019re all set.','freshly updated.','everything\\u2019s ready for you.','good to go.']"
    : "['your community is waiting.','come say hi.','let\\u2019s go find your people.','everything\\u2019s ready for you.']";
  const statusesJs = isUpdate
    ? "['applying update\\u2026','swapping in the new build\\u2026','tidying things up\\u2026','almost there\\u2026']"
    : "['generating keys\\u2026','doing the math\\u2026','shuffling primes\\u2026','scrambling bits\\u2026','encrypting\\u2026']";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; script-src 'unsafe-inline'">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&family=Nunito:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --cl-abyss:   #0B0F1E;
    --cl-deep:    #131A30;
    --cl-surface: #1C2542;
    --cl-border:  #2A3558;
    --cl-sink:    #0A1120;
    --cl-lume:        #25E0C8;
    --cl-lume-hi:     #3BEAD6;
    --cl-lume-deep:   #0E8F7C;
    --cl-glow:    #FFC94D;
    --cl-ok:      #4ADE80;
    --cl-text:  #F4F7FF;
    --cl-muted: #A7B3D4;
    --cl-faint: #5E6B8F;
    --cl-font-display: 'Fredoka', system-ui, sans-serif;
    --cl-font-body:    'Nunito', system-ui, sans-serif;
    --cl-font-mono:    'JetBrains Mono', ui-monospace, monospace;
    --cl-spring: cubic-bezier(.34, 1.56, .64, 1);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--cl-font-body);
    overflow: hidden;
    user-select: none;
    cursor: default;
  }

  @keyframes cl-blink { 0%,100%{opacity:.22} 50%{opacity:1} }
  @keyframes cl-bars  { 0%{transform:scaleY(.34)} 100%{transform:scaleY(1)} }
  @keyframes cl-ring  { 0%{transform:translate(-50%,-50%) scale(.5);opacity:.55} 75%{opacity:0} 100%{transform:translate(-50%,-50%) scale(2.2);opacity:0} }
  @keyframes cl-tape  { from{transform:translateY(0)} to{transform:translateY(-50%)} }
  @keyframes cl-pop   { 0%{transform:scale(.62)} 55%{transform:scale(1.1)} 100%{transform:scale(1)} }
  @keyframes cl-breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.035)} }
  @keyframes cl-halo  { 0%,100%{opacity:.42;transform:translate(-50%,-50%) scale(1)} 50%{opacity:.72;transform:translate(-50%,-50%) scale(1.14)} }
  @keyframes cl-ringdone { 0%{transform:translate(-50%,-50%) scale(.45);opacity:.6} 80%{opacity:0} 100%{transform:translate(-50%,-50%) scale(2.5);opacity:0} }
  @keyframes cl-confetti { 0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0} 14%{opacity:1} 72%{opacity:1} 100%{transform:translate(var(--dx),var(--dy)) scale(1) rotate(var(--r));opacity:0} }
  @keyframes cl-glowpulse { 0%,100%{box-shadow:0 0 16px rgba(37,224,200,.30)} 50%{box-shadow:0 0 26px rgba(37,224,200,.55)} }
  @keyframes cl-rise  { 0%{transform:translateY(9px);opacity:0} 100%{transform:translateY(0);opacity:1} }
  @keyframes cl-fadein { 0%{opacity:0} 100%{opacity:1} }

  .card {
    position: relative;
    width: 440px;
    background: var(--cl-deep);
    border: 1px solid var(--cl-border);
    border-radius: 20px;
    box-shadow: 0 24px 60px rgba(0,0,0,.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* the title bar drags the whole window */
  .titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--cl-border);
    -webkit-app-region: drag;
  }
  .titlebar .brand {
    font-family: var(--cl-font-display);
    font-weight: 500;
    font-size: 16px;
    color: var(--cl-text);
  }
  .titlebar .ver {
    font-family: var(--cl-font-mono);
    font-size: 11px;
    color: var(--cl-faint);
  }

  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 44px 28px 36px;
    /* Fixed (not min-) height so the card is pixel-identical across the
       working and done states — otherwise the taller working content makes
       the stage grow, then snaps shorter on completion. box-sizing is
       border-box, so this includes the 80px vertical padding; the working
       state (~217px content) fits with room to spare. */
    height: 320px;
  }

  .mark-wrap { position: relative; width: 84px; height: 70px; display: flex; align-items: center; justify-content: center; }
  .pulse-ring { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; border-radius: 50%; border: 1.5px solid var(--cl-lume); animation: cl-ring 2.6s ease-out infinite; }

  .tape-mask {
    position: relative; width: 160px; height: 78px; overflow: hidden;
    -webkit-mask: linear-gradient(to bottom, transparent, #000 26%, #000 74%, transparent);
    mask: linear-gradient(to bottom, transparent, #000 26%, #000 74%, transparent);
  }
  .tape-scroll { display: flex; flex-direction: column; gap: 6px; align-items: center; animation: cl-tape 6s linear infinite; }
  .tape-scroll span { font-family: var(--cl-font-mono); font-size: 12px; color: var(--cl-lume); opacity: .5; letter-spacing: 1.5px; }

  .key-pill {
    display: flex; align-items: center; gap: 8px; padding: 8px 15px;
    background: var(--cl-surface); border: 1px solid var(--cl-border);
    border-radius: 99px; box-shadow: 0 0 18px rgba(37,224,200,.18);
  }
  .key-pill .fp { font-family: var(--cl-font-mono); font-size: 13px; color: var(--cl-lume); letter-spacing: 1px; }

  .footer { padding: 0 24px 22px; display: flex; flex-direction: column; gap: 13px; }
  .statusline { display: flex; align-items: center; gap: 8px; min-height: 18px; }
  .statusdot { width: 7px; height: 7px; border-radius: 99px; background: var(--cl-lume); box-shadow: 0 0 8px var(--cl-lume); flex: none; animation: cl-blink 1.4s ease-in-out infinite; }
  .statustext { font-family: var(--cl-font-mono); font-size: 13px; color: var(--cl-muted); letter-spacing: .2px; }
  .spacer { flex: 1; }
  .pct { font-family: var(--cl-font-mono); font-size: 12px; color: var(--cl-faint); }

  .bar { position: relative; height: 8px; border-radius: 99px; background: var(--cl-sink); border: 1px solid var(--cl-border); overflow: hidden; }
  .bar-fill {
    height: 100%; width: 0%; border-radius: 99px;
    background: linear-gradient(90deg, var(--cl-lume-deep), var(--cl-lume));
    box-shadow: 0 0 12px rgba(37,224,200,.5);
    transition: width .22s ease-out;
  }

  /* ===== done state ===== */
  #done { display: none; }
  .done-mark-stage { position: relative; width: 96px; height: 80px; display: flex; align-items: center; justify-content: center; }
  .halo { position: absolute; left: 50%; top: 50%; width: 104px; height: 104px; border-radius: 50%; background: radial-gradient(circle, rgba(37,224,200,.55), transparent 68%); animation: cl-halo 2.8s ease-in-out infinite; }
  .ring-done { position: absolute; left: 50%; top: 50%; width: 78px; height: 78px; border-radius: 50%; border: 2px solid var(--cl-lume); opacity: 0; animation: cl-ringdone 1.4s ease-out 2; }
  .done-mark { position: relative; z-index: 2; animation: cl-pop 560ms var(--cl-spring) both; }
  .done-mark > div { animation: cl-breathe 3.2s ease-in-out infinite; }
  .headline { display: flex; flex-direction: column; align-items: center; gap: 5px; animation: cl-rise 460ms var(--cl-spring) both; animation-delay: 200ms; }
  .headline .big { font-family: var(--cl-font-display); font-weight: 600; font-size: 27px; color: var(--cl-text); letter-spacing: -.5px; white-space: nowrap; }
  .headline .sub { font-size: 13.5px; color: var(--cl-muted); white-space: nowrap; }
  .confetti { position: absolute; left: 50%; top: 50%; }
</style>
</head>
<body>
  <div class="card">
    <div class="titlebar">
      <svg width="20" height="17" viewBox="0 0 110 90"><rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"></path></svg>
      <span class="brand">cipherline</span>
      <span class="spacer"></span>
      <span class="ver" id="ver">${verbing} ${safeVersion}</span>
    </div>

    <div class="stage">
      <!-- ===== WORKING ===== -->
      <div id="working" style="display:flex; flex-direction:column; align-items:center; gap:18px;">
        <div class="mark-wrap">
          <div class="pulse-ring"></div>
          <div class="pulse-ring" style="animation-delay:1.3s;"></div>
          <svg width="70" height="58" viewBox="0 0 110 90" style="position:relative; z-index:2; filter:drop-shadow(0 0 10px rgba(37,224,200,.6));">
            <rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:0ms;"></rect>
            <rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:130ms;"></rect>
            <rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:260ms;"></rect>
            <rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:390ms;"></rect>
            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"></path>
            <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </div>

        <div class="tape-mask">
          <div class="tape-scroll" id="tape"></div>
        </div>

        <div class="key-pill">
          <svg width="14" height="15" viewBox="0 0 24 26" fill="none" stroke="var(--cl-lume)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="12" rx="3.5"></rect><path d="M7.5 11 V8 a4.5 4.5 0 0 1 9 0 V11"></path></svg>
          <span class="fp" id="fp"></span>
        </div>
      </div>

      <!-- ===== DONE ===== -->
      <div id="done">
        <div style="position:relative; display:flex; flex-direction:column; align-items:center; gap:18px;">
          <div class="done-mark-stage">
            <div class="halo"></div>
            <div class="ring-done"></div>
            <div class="ring-done" style="animation-delay:.5s;"></div>
            <div id="confetti-host"></div>
            <div class="done-mark">
              <div>
                <svg width="84" height="69" viewBox="0 0 110 90" style="display:block; filter:drop-shadow(0 0 14px rgba(37,224,200,.7));">
                  <rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect>
                  <rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect>
                  <rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect>
                  <rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect>
                  <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"></path>
                  <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
                  <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
              </div>
            </div>
          </div>
          <div class="headline">
            <div class="big">${headline}</div>
            <div class="sub" id="sub">${defaultSub}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="statusline">
        <span class="statusdot" id="dot"></span>
        <span class="statustext" id="status">getting things ready&hellip;</span>
        <span class="spacer"></span>
        <span class="pct" id="pctlabel">0%</span>
      </div>
      <div class="bar">
        <div class="bar-fill" id="barfill"></div>
      </div>
    </div>
  </div>

<script>
(function(){
  var rc = function(){ return '0123456789abcdef'[(Math.random()*16)|0]; };
  var pairs = function(n){ var a=[]; for(var i=0;i<n;i++) a.push(rc()+rc()); return a.join(' '); };

  // hex "tape" spooling out — duplicated so the loop is seamless
  var tapeEl = document.getElementById('tape');
  var rows = [];
  for (var i=0;i<26;i++) rows.push(pairs(3));
  var frag = document.createDocumentFragment();
  for (var k=0;k<2;k++) for (var j=0;j<rows.length;j++) { var s=document.createElement('span'); s.textContent=rows[j]; frag.appendChild(s); }
  tapeEl.appendChild(frag);

  // scrambling key fingerprint
  var fpEl = document.getElementById('fp');
  var fpTimer = setInterval(function(){ fpEl.textContent = pairs(5); }, 95);
  fpEl.textContent = pairs(5);

  // cycling status copy (working state)
  var statuses = ${statusesJs};
  var statusEl = document.getElementById('status');
  var statusIdx = 0, statusOverride = null, done = false;
  var statusTimer = setInterval(function(){
    if (done || statusOverride) return;
    statusIdx++;
    statusEl.textContent = statuses[statusIdx % statuses.length];
  }, 1800);
  statusEl.textContent = statuses[0];

  // ===== real progress bar — eased toward a target the main process sets =====
  var barEl = document.getElementById('barfill');
  var pctLabel = document.getElementById('pctlabel');
  var target = 0, display = 0;
  function tick(){
    // ease toward target; never quite reach it until completion drives it to 100
    var d = target - display;
    if (Math.abs(d) > 0.1) display += d * 0.18;
    else display = target;
    barEl.style.width = display.toFixed(2) + '%';
    if (!done) pctLabel.textContent = Math.round(display) + '%';
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ===== globals the main process calls via executeJavaScript =====
  window.clProgress = function(pct){
    if (done) return;
    pct = Math.max(0, Math.min(99, Number(pct) || 0));
    if (pct > target) target = pct;
  };
  window.clStatus = function(text){
    if (done) return;
    statusOverride = String(text || '');
    statusEl.textContent = statusOverride;
  };

  var SUBS = ${subsJs};
  function fireConfetti(){
    var host = document.getElementById('confetti-host');
    var cols = ['var(--cl-lume)','var(--cl-lume-hi)','var(--cl-glow)','var(--cl-ok)'];
    var N = 20;
    for (var i=0;i<N;i++){
      var ang = (i/N)*Math.PI*2 + (Math.random()*0.5-0.25);
      var dist = 56 + Math.random()*44;
      var dx = Math.cos(ang)*dist;
      var dy = Math.sin(ang)*dist - 12;
      var sz = 4 + Math.random()*4;
      var col = cols[(Math.random()*cols.length)|0];
      var round = Math.random() > 0.5;
      var s = document.createElement('span');
      s.className = 'confetti';
      s.style.width = sz+'px'; s.style.height = sz+'px';
      s.style.marginLeft = (-sz/2)+'px'; s.style.marginTop = (-sz/2)+'px';
      s.style.background = col; s.style.borderRadius = round ? '99px' : '2px';
      s.style.boxShadow = '0 0 7px '+col;
      s.style.setProperty('--dx', dx+'px');
      s.style.setProperty('--dy', dy+'px');
      s.style.setProperty('--r', ((Math.random()*2-1)*240)+'deg');
      s.style.animation = 'cl-confetti '+(660+Math.random()*280)+'ms var(--cl-spring) forwards';
      s.style.animationDelay = (Math.random()*90)+'ms';
      s.style.zIndex = '1';
      host.appendChild(s);
    }
  }

  // Called as the main process grows the window into the app footprint — fade
  // and gently push the card back so the expanding window dissolves into the
  // abyss before the real app window is revealed on top.
  window.clDissolve = function(){
    var card = document.querySelector('.card');
    if (card) {
      card.style.transition = 'opacity .34s ease, transform .46s cubic-bezier(.34,1.56,.64,1)';
      card.style.opacity = '0';
      card.style.transform = 'scale(1.06)';
    }
    document.body.style.transition = 'background .3s ease';
  };

  window.clComplete = function(){
    if (done) return;
    done = true;
    clearInterval(fpTimer);
    clearInterval(statusTimer);
    target = 100; display = 100;
    barEl.style.width = '100%';
    barEl.style.animation = 'cl-glowpulse 2.4s ease-in-out infinite';
    pctLabel.textContent = '';
    document.getElementById('ver').textContent = 'cipherline ${safeVersion}';
    document.getElementById('sub').textContent = SUBS[(Math.random()*SUBS.length)|0];
    // swap status line to the success state
    var dot = document.getElementById('dot');
    dot.style.animation = 'none';
    dot.style.width = '8px'; dot.style.height = '8px';
    dot.style.background = 'var(--cl-ok)'; dot.style.boxShadow = '0 0 9px var(--cl-ok)';
    statusEl.style.color = 'var(--cl-ok)';
    statusEl.textContent = '${successLine}';
    // swap working → done
    document.getElementById('working').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    fireConfetti();
  };
})();
</script>
</body>
</html>`;
}

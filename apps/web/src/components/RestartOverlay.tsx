const restartSvg = `<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 512 512"
     width="512"
     height="512">

  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2864ff"/>
      <stop offset="100%" stop-color="#24d5e9"/>
    </linearGradient>

    <linearGradient id="orange" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffba42"/>
      <stop offset="55%" stop-color="#ff7650"/>
      <stop offset="100%" stop-color="#ff4d82"/>
    </linearGradient>

    <linearGradient id="purple" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4934df"/>
      <stop offset="55%" stop-color="#7338ed"/>
      <stop offset="100%" stop-color="#a84cff"/>
    </linearGradient>

    <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1ed4c1"/>
      <stop offset="100%" stop-color="#a1ee70"/>
    </linearGradient>

    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".18"/>
    </filter>

    <clipPath id="clip">
      <rect x="156" y="156" width="200" height="200" rx="34"/>
    </clipPath>

    <style><![CDATA[
      .state,
      .anim {
        transform-box: fill-box;
        transform-origin: center;
      }

      .state {
        opacity: 0;
      }

      .s1 { animation: state1 8s linear infinite; }
      .s2 { animation: state2 8s linear infinite; }
      .s3 { animation: state3 8s linear infinite; }
      .s4 { animation: state4 8s linear infinite; }

      .a1-bg      { animation: a1bg 8s linear infinite; }
      .a1-shine   { animation: a1shine 8s linear infinite; }
      .a1-dot1    { animation: a1dot1 8s linear infinite; }
      .a1-dot2    { animation: a1dot2 8s linear infinite; }
      .a1-border  { animation: a1border 8s linear infinite; }
      .a1-p       { animation: a1p 8s linear infinite; }

      .a2-bg      { animation: a2bg 8s linear infinite; }
      .a2-arc1    { animation: a2arc1 8s linear infinite; }
      .a2-arc2    { animation: a2arc2 8s linear infinite; }
      .a2-dot1    { animation: a2dot1 8s linear infinite; }
      .a2-dot2    { animation: a2dot2 8s linear infinite; }
      .a2-dot3    { animation: a2dot3 8s linear infinite; }
      .a2-pill1   { animation: a2pill1 8s linear infinite; }
      .a2-pill2   { animation: a2pill2 8s linear infinite; }
      .a2-border  { animation: a2border 8s linear infinite; }
      .a2-p       { animation: a2p 8s linear infinite; }

      .a3-bg      { animation: a3bg 8s linear infinite; }
      .a3-c1      { animation: a3c1 8s linear infinite; }
      .a3-c2      { animation: a3c2 8s linear infinite; }
      .a3-c3      { animation: a3c3 8s linear infinite; }
      .a3-c4      { animation: a3c4 8s linear infinite; }
      .a3-dot1    { animation: a3dot1 8s linear infinite; }
      .a3-dot2    { animation: a3dot2 8s linear infinite; }
      .a3-slash1  { animation: a3slash1 8s linear infinite; }
      .a3-slash2  { animation: a3slash2 8s linear infinite; }
      .a3-border  { animation: a3border 8s linear infinite; }
      .a3-p       { animation: a3p 8s linear infinite; }

      .a4-bg      { animation: a4bg 8s linear infinite; }
      .a4-v1      { animation: a4v1 8s linear infinite; }
      .a4-v2      { animation: a4v2 8s linear infinite; }
      .a4-v3      { animation: a4v3 8s linear infinite; }
      .a4-v4      { animation: a4v4 8s linear infinite; }
      .a4-h1      { animation: a4h1 8s linear infinite; }
      .a4-h2      { animation: a4h2 8s linear infinite; }
      .a4-h3      { animation: a4h3 8s linear infinite; }
      .a4-h4      { animation: a4h4 8s linear infinite; }
      .a4-dot1    { animation: a4dot1 8s linear infinite; }
      .a4-dot2    { animation: a4dot2 8s linear infinite; }
      .a4-corner1 { animation: a4corner1 8s linear infinite; }
      .a4-corner2 { animation: a4corner2 8s linear infinite; }
      .a4-circle  { animation: a4circle 8s linear infinite; }
      .a4-border  { animation: a4border 8s linear infinite; }
      .a4-p       { animation: a4p 8s linear infinite; }

      @keyframes state1 {
        0%, 24.9% { opacity: 1; }
        25%, 100% { opacity: 0; }
      }
      @keyframes state2 {
        0%, 24.9% { opacity: 0; }
        25%, 49.9% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      @keyframes state3 {
        0%, 49.9% { opacity: 0; }
        50%, 74.9% { opacity: 1; }
        75%, 100% { opacity: 0; }
      }
      @keyframes state4 {
        0%, 74.9% { opacity: 0; }
        75%, 100% { opacity: 1; }
      }

      @keyframes a1bg {
        0% { opacity: 0; transform: scale(.78); }
        3.5%, 24.9% { opacity: 1; transform: scale(1); }
        25%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a1shine {
        0% { opacity: 0; transform: translateY(-30px); }
        4.2%, 24.9% { opacity: .14; transform: translateY(0); }
        25%, 100% { opacity: 0; transform: translateY(0); }
      }
      @keyframes a1dot1 {
        0% { opacity: 0; transform: scale(0); }
        4.8%, 24.9% { opacity: .09; transform: scale(1); }
        25%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a1dot2 {
        0% { opacity: 0; transform: scale(0); }
        5.2%, 24.9% { opacity: .20; transform: scale(1); }
        25%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a1border {
        0% { opacity: 0; transform: scale(.88); }
        5.8%, 24.9% { opacity: 1; transform: scale(1); }
        25%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a1p {
        0% { opacity: 0; transform: scale(.6) translateY(16px); }
        6.4%, 24.9% { opacity: 1; transform: scale(1) translateY(0); }
        25%, 100% { opacity: 0; transform: scale(1) translateY(0); }
      }

      @keyframes a2bg {
        0%, 25% { opacity: 0; transform: scale(.78); }
        28.2%, 49.9% { opacity: 1; transform: scale(1); }
        50%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a2arc1 {
        0%, 26.2% { opacity: 0; transform: translate(-36px,26px) scale(.8); }
        29.2%, 49.9% { opacity: .18; transform: translate(0,0) scale(1); }
        50%, 100% { opacity: 0; transform: translate(0,0) scale(1); }
      }
      @keyframes a2arc2 {
        0%, 26.8% { opacity: 0; transform: translate(36px,-26px) scale(.8); }
        29.8%, 49.9% { opacity: .14; transform: translate(0,0) scale(1); }
        50%, 100% { opacity: 0; transform: translate(0,0) scale(1); }
      }
      @keyframes a2dot1 {
        0%, 27.4% { opacity: 0; transform: scale(0); }
        30%, 49.9% { opacity: .22; transform: scale(1); }
        50%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a2dot2 {
        0%, 27.9% { opacity: 0; transform: scale(0); }
        30.4%, 49.9% { opacity: .13; transform: scale(1); }
        50%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a2dot3 {
        0%, 28.3% { opacity: 0; transform: scale(0); }
        30.8%, 49.9% { opacity: .38; transform: scale(1); }
        50%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a2pill1 {
        0%, 28.6% { opacity: 0; transform: translateX(-28px); }
        31.2%, 49.9% { opacity: 1; transform: translateX(0); }
        50%, 100% { opacity: 0; transform: translateX(0); }
      }
      @keyframes a2pill2 {
        0%, 28.9% { opacity: 0; transform: translateX(28px); }
        31.5%, 49.9% { opacity: 1; transform: translateX(0); }
        50%, 100% { opacity: 0; transform: translateX(0); }
      }
      @keyframes a2border {
        0%, 29.4% { opacity: 0; transform: scale(.88); }
        32%, 49.9% { opacity: 1; transform: scale(1); }
        50%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a2p {
        0%, 29.8% { opacity: 0; transform: scale(.62) translateY(16px); }
        32.5%, 49.9% { opacity: 1; transform: scale(1) translateY(0); }
        50%, 100% { opacity: 0; transform: scale(1) translateY(0); }
      }

      @keyframes a3bg {
        0%, 50% { opacity: 0; transform: scale(.78); }
        53.2%, 74.9% { opacity: 1; transform: scale(1); }
        75%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a3c1 {
        0%, 51% { opacity: 0; transform: translate(-22px,-22px); }
        53.8%, 74.9% { opacity: .28; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3c2 {
        0%, 51.4% { opacity: 0; transform: translate(22px,-22px); }
        54.2%, 74.9% { opacity: .20; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3c3 {
        0%, 51.8% { opacity: 0; transform: translate(-22px,22px); }
        54.6%, 74.9% { opacity: .18; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3c4 {
        0%, 52.2% { opacity: 0; transform: translate(22px,22px); }
        55%, 74.9% { opacity: .28; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3dot1 {
        0%, 52.6% { opacity: 0; transform: scale(0); }
        55.4%, 74.9% { opacity: .34; transform: scale(1); }
        75%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a3dot2 {
        0%, 53% { opacity: 0; transform: scale(0); }
        55.8%, 74.9% { opacity: .20; transform: scale(1); }
        75%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a3slash1 {
        0%, 53.4% { opacity: 0; transform: translate(-18px,18px); }
        56.2%, 74.9% { opacity: 1; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3slash2 {
        0%, 53.8% { opacity: 0; transform: translate(18px,-18px); }
        56.6%, 74.9% { opacity: 1; transform: translate(0,0); }
        75%, 100% { opacity: 0; transform: translate(0,0); }
      }
      @keyframes a3border {
        0%, 54.2% { opacity: 0; transform: scale(.88); }
        57%, 74.9% { opacity: 1; transform: scale(1); }
        75%, 100% { opacity: 0; transform: scale(1); }
      }
      @keyframes a3p {
        0%, 54.6% { opacity: 0; transform: scale(.62) translateY(16px); }
        57.4%, 74.9% { opacity: 1; transform: scale(1) translateY(0); }
        75%, 100% { opacity: 0; transform: scale(1) translateY(0); }
      }

      @keyframes a4bg {
        0%, 75% { opacity: 0; transform: scale(.78); }
        78.2%, 100% { opacity: 1; transform: scale(1); }
      }
      @keyframes a4v1 {
        0%, 76% { opacity: 0; transform: translateY(-160px); }
        79%, 100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes a4v2 {
        0%, 76.4% { opacity: 0; transform: translateY(160px); }
        79.4%, 100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes a4v3 {
        0%, 76.8% { opacity: 0; transform: translateY(-160px); }
        79.8%, 100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes a4v4 {
        0%, 77.2% { opacity: 0; transform: translateY(160px); }
        80.2%, 100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes a4h1 {
        0%, 76.2% { opacity: 0; transform: translateX(-160px); }
        79.2%, 100% { opacity: 1; transform: translateX(0); }
      }
      @keyframes a4h2 {
        0%, 76.6% { opacity: 0; transform: translateX(160px); }
        79.6%, 100% { opacity: 1; transform: translateX(0); }
      }
      @keyframes a4h3 {
        0%, 77% { opacity: 0; transform: translateX(-160px); }
        80%, 100% { opacity: 1; transform: translateX(0); }
      }
      @keyframes a4h4 {
        0%, 77.4% { opacity: 0; transform: translateX(160px); }
        80.4%, 100% { opacity: 1; transform: translateX(0); }
      }
      @keyframes a4dot1 {
        0%, 77.8% { opacity: 0; transform: scale(0); }
        80.8%, 100% { opacity: .20; transform: scale(1); }
      }
      @keyframes a4dot2 {
        0%, 78.2% { opacity: 0; transform: scale(0); }
        81.2%, 100% { opacity: .25; transform: scale(1); }
      }
      @keyframes a4corner1 {
        0%, 78.6% { opacity: 0; transform: translate(-22px,-22px); }
        81.6%, 100% { opacity: 1; transform: translate(0,0); }
      }
      @keyframes a4corner2 {
        0%, 79% { opacity: 0; transform: translate(22px,22px); }
        82%, 100% { opacity: 1; transform: translate(0,0); }
      }
      @keyframes a4circle {
        0%, 79.4% { opacity: 0; transform: scale(0); }
        82.4%, 100% { opacity: .13; transform: scale(1); }
      }
      @keyframes a4border {
        0%, 79.8% { opacity: 0; transform: scale(.88); }
        82.8%, 100% { opacity: 1; transform: scale(1); }
      }
      @keyframes a4p {
        0%, 80.2% { opacity: 0; transform: scale(.62) translateY(16px); }
        83.2%, 100% { opacity: 1; transform: scale(1) translateY(0); }
      }
    ]]></style>
  </defs>

  <g filter="url(#shadow)">
    <g clip-path="url(#clip)">

      <g class="state s1">
        <rect class="anim a1-bg" x="156" y="156" width="200" height="200" rx="34" fill="url(#blue)"/>
        <path class="anim a1-shine"
              d="M145 154H370V220
                 C315 188 212 191 145 232Z"
              fill="#fff"/>
        <circle class="anim a1-dot1" cx="311" cy="204" r="23" fill="#fff"/>
        <circle class="anim a1-dot2" cx="201" cy="304" r="7" fill="#fff"/>
        <rect class="anim a1-border"
              x="169" y="169" width="174" height="174" rx="25"
              fill="none" stroke="#fff" stroke-opacity=".23" stroke-width="3"/>
        <text class="anim a1-p"
              x="256" y="299"
              text-anchor="middle"
              font-family="Arial, Helvetica, sans-serif"
              font-size="142"
              font-weight="900"
              fill="#fff">P</text>
      </g>

      <g class="state s2">
        <rect class="anim a2-bg" x="156" y="156" width="200" height="200" rx="34" fill="url(#orange)"/>

        <path class="anim a2-arc1"
              d="M151 313
                 C176 287 187 274 190 247
                 C192 229 184 212 167 198"
              fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>

        <path class="anim a2-arc2"
              d="M321 165
                 C340 181 351 200 354 221
                 C356 237 353 249 347 261"
              fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>

        <circle class="anim a2-dot1" cx="186" cy="187" r="10" fill="#fff"/>
        <circle class="anim a2-dot2" cx="326" cy="316" r="15" fill="#fff"/>
        <circle class="anim a2-dot3" cx="331" cy="188" r="5" fill="#fff"/>

        <rect class="anim a2-pill1" x="171" y="324" width="40" height="8" rx="4" fill="#fff"/>
        <rect class="anim a2-pill2" x="300" y="178" width="26" height="7" rx="4" fill="#fff"/>

        <rect class="anim a2-border"
              x="169" y="169" width="174" height="174" rx="25"
              fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="3"/>

        <text class="anim a2-p"
              x="256" y="297"
              text-anchor="middle"
              font-family="Georgia, serif"
              font-size="139"
              font-weight="700"
              font-style="italic"
              fill="#fff">P</text>
      </g>

      <g class="state s3">
        <rect class="anim a3-bg" x="156" y="156" width="200" height="200" rx="34" fill="url(#purple)"/>

        <path class="anim a3-c1"
              d="M181 208V181H208"
              fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>

        <path class="anim a3-c2"
              d="M304 181H331V208"
              fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>

        <path class="anim a3-c3"
              d="M181 304V331H208"
              fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>

        <path class="anim a3-c4"
              d="M304 331H331V304"
              fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>

        <circle class="anim a3-dot1" cx="192" cy="247" r="5" fill="#fff"/>
        <circle class="anim a3-dot2" cx="319" cy="268" r="7" fill="#fff"/>

        <path class="anim a3-slash1"
              d="M185 288L207 278"
              stroke="#fff" stroke-width="4" stroke-linecap="round"/>

        <path class="anim a3-slash2"
              d="M306 224L328 214"
              stroke="#fff" stroke-width="4" stroke-linecap="round"/>

        <rect class="anim a3-border"
              x="169" y="169" width="174" height="174" rx="25"
              fill="none" stroke="#fff" stroke-opacity=".20" stroke-width="3"/>

        <text class="anim a3-p"
              x="256" y="296"
              text-anchor="middle"
              font-family="Courier New, monospace"
              font-size="128"
              font-weight="700"
              fill="#fff">P</text>
      </g>

      <g class="state s4">
        <rect class="anim a4-bg" x="156" y="156" width="200" height="200" rx="34" fill="url(#mint)"/>

        <g stroke="#173746" stroke-opacity=".11" stroke-width="2">
          <path class="anim a4-v1" d="M196 156V356"/>
          <path class="anim a4-v2" d="M236 156V356"/>
          <path class="anim a4-v3" d="M276 156V356"/>
          <path class="anim a4-v4" d="M316 156V356"/>

          <path class="anim a4-h1" d="M156 196H356"/>
          <path class="anim a4-h2" d="M156 236H356"/>
          <path class="anim a4-h3" d="M156 276H356"/>
          <path class="anim a4-h4" d="M156 316H356"/>
        </g>

        <circle class="anim a4-dot1" cx="313" cy="199" r="7" fill="#173746"/>
        <circle class="anim a4-dot2" cx="197" cy="306" r="5" fill="#173746"/>

        <circle class="anim a4-circle"
                cx="306" cy="295" r="35"
                fill="none" stroke="#173746" stroke-width="4"/>

        <path class="anim a4-corner1"
              d="M180 207V180H207"
              fill="none" stroke="#173746" stroke-opacity=".34" stroke-width="5" stroke-linecap="round"/>

        <path class="anim a4-corner2"
              d="M332 305V332H305"
              fill="none" stroke="#173746" stroke-opacity=".34" stroke-width="5" stroke-linecap="round"/>

        <rect class="anim a4-border"
              x="169" y="169" width="174" height="174" rx="25"
              fill="none" stroke="#173746" stroke-opacity=".20" stroke-width="3"/>

        <text class="anim a4-p"
              x="256" y="298"
              text-anchor="middle"
              font-family="Verdana, Arial, sans-serif"
              font-size="137"
              font-weight="900"
              fill="#173746">P</text>
      </g>

    </g>
  </g>
</svg>`;

export default function RestartOverlay() {
  return (
    <div className="opencode-restart-overlay" role="status" aria-live="assertive" aria-label="Restarting OpenCode">
      <div
        className="opencode-restart-mark"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: restartSvg }}
      />
      <span>Applying changes and restarting OpenCode…</span>
    </div>
  );
}

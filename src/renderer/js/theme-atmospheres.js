// Bounded, decorative SVG geometry. CSS owns motion, visibility and reduced
// motion, so moving a live output into another document needs no timer,
// observer, canvas recreation, or animation-controller handoff.
export function mountThemeAtmospheres(host) {
  const doc = host.ownerDocument;
  const svg = (tag, attrs, parent) => {
    const el = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    parent.append(el);
    return el;
  };
  const scene = id => svg('svg', {
    class: 'theme-atmosphere', 'data-effect': id, viewBox: '0 0 1000 600',
    preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  }, host);
  const path = (parent, d, name, attrs = {}) => svg('path', { d, class: name, fill: 'none', ...attrs }, parent);
  const timing = (duration, delay) => `--effect-duration:${duration}s;--effect-delay:${delay}s`;

  const ion = scene('ion-storm');
  const branches = [
    'M490 -30 L527 57 506 100 557 157 528 206 579 259 556 310 607 365 580 429 617 489 594 553 633 630',
    'M630 -30 L602 54 656 105 624 163 675 212 641 270 693 325 662 382 711 437 677 491 723 555 700 630',
    'M730 -30 L776 45 749 98 801 150 768 213 818 260 787 312 837 368 801 424 853 482 820 546 864 630',
    'M900 -30 L861 54 910 110 878 161 927 219 896 274 945 329 912 381 963 440 930 492 978 552 952 630',
    'M1030 10 L970 69 1003 121 956 180 986 236 943 294 977 354 936 415 969 478 931 540 966 610',
  ];
  branches.forEach((d, i) => {
    const group = svg('g', { class: 'theme-ion-branch', style: timing(12 + i * 1.5, -i * 2.8) }, ion);
    path(group, d, 'theme-ion-halo');
    path(group, d, 'theme-ion-trace');
    path(group, d, 'theme-ion-pulse', { pathLength: 100, style: timing(5.5 + i * .6, -i * 1.7) });
  });
  [
    'M528 206 L473 224 451 277 409 299', 'M693 325 L745 342 756 395 791 414',
    'M801 424 L751 448 740 495 696 517', 'M878 161 L828 178 807 224 772 244',
    'M617 489 L663 515 676 567 709 588',
  ].forEach(d => path(ion, d, 'theme-ion-fork'));

  const solar = scene('solar-flare');
  const corona = svg('g', { class: 'theme-solar-corona' }, solar);
  const flares = [
    'M660 379 C589 271 637 254 694 324 C752 259 841 259 908 315 C984 238 1026 293 943 374',
    'M647 432 C570 407 573 366 647 388 C657 302 722 257 798 272 C819 195 873 233 840 285',
    'M682 536 C593 582 614 626 711 568 C769 609 861 615 917 555 C1000 593 1028 553 950 509',
    'M642 455 C559 474 590 528 667 503 C670 550 711 581 755 594',
    'M882 288 C936 206 980 234 927 327 C965 372 976 424 959 473 C1041 481 1058 526 951 517',
  ];
  flares.forEach((d, i) => {
    const group = svg('g', { class: 'theme-solar-flare', style: timing(10 + i * 2, -i * 2.4) }, corona);
    path(group, d, 'theme-solar-flare-halo');
    path(group, d, 'theme-solar-flare-line');
  });
  svg('circle', { cx: 805, cy: 440, r: 154, class: 'theme-solar-disc' }, solar);
  path(solar, 'M731 306 C601 364 628 528 759 579 C682 513 664 389 731 306Z', 'theme-solar-crescent');
  path(solar, 'M746 294 C675 321 636 382 650 459 C663 524 714 572 773 586', 'theme-solar-limb');

  const aurora = scene('aurora-flux');
  for (let i = 0; i < 5; i++) {
    const shift = i * 55;
    const d = `M${435 + shift} -65 C${730 + shift} 90 ${330 + shift} 235 ${585 + shift} 361 S${680 + shift} 550 ${800 + shift} 665`;
    const group = svg('g', { class: 'theme-aurora-curtain', style: timing(15 + i * 2.1, -i * 3.7) }, aurora);
    path(group, d, 'theme-aurora-bloom');
    path(group, d, 'theme-aurora-ribbon');
    for (let j = -3; j <= 3; j++) {
      path(group, d, 'theme-aurora-filament', { transform: `translate(${j * 5} 0)` });
    }
  }

  const stars = scene('hyperdrive');
  // Independent deterministic phases keep a stable vanishing point. No
  // rotating field/pinwheel, random re-seeding, or frame-by-frame allocation.
  for (let i = 0; i < 72; i++) {
    const seed = ((i * 73 + 19) % 101) / 101;
    const angle = (i * 2.399963229728653) % (Math.PI * 2);
    const x = 810 + Math.cos(angle) * 1200;
    const y = 390 + Math.sin(angle) * 900;
    path(stars, `M810 390 L${x.toFixed(2)} ${y.toFixed(2)}`, 'theme-star-streak', {
      pathLength: 100, style: timing((3.7 + seed * 4).toFixed(2), (-seed * 8).toFixed(2)),
      'stroke-width': (1 + seed * 1.2).toFixed(2),
    });
  }

  const circuit = scene('ghost-circuit');
  const routes = [
    [420, 0, 420, 90, 490, 160, 490, 340, 565, 415, 565, 600],
    [535, 0, 535, 65, 610, 140, 610, 290, 690, 370, 690, 600],
    [670, 0, 670, 110, 745, 185, 745, 325, 825, 405, 825, 600],
    [810, 0, 810, 85, 885, 160, 885, 300, 955, 370, 955, 600],
    [960, 0, 960, 85, 925, 120, 925, 250, 990, 315, 1040, 315],
    [330, 250, 420, 250, 465, 295, 465, 450, 525, 510, 525, 600],
    [1000, 100, 960, 100, 920, 140, 850, 140, 795, 195, 795, 300],
    [1000, 460, 925, 460, 865, 520, 750, 520, 715, 555, 715, 600],
    [590, 0, 590, 70, 650, 130, 650, 220, 705, 275, 705, 335],
    [1000, 560, 900, 560, 860, 600],
    [355, 480, 420, 480, 455, 515, 455, 600],
    [745, 0, 745, 70, 780, 105, 780, 160],
  ];
  routes.forEach((points, i) => {
    const d = 'M' + points.slice(0, 2).join(' ') + ' L' + points.slice(2).join(' ');
    path(circuit, d, 'theme-circuit-trace');
    path(circuit, d, 'theme-circuit-packet', { pathLength: 100, style: timing(6 + i % 4 * 1.4, -i * .83) });
    svg('rect', { x: points.at(-2) - 3, y: points.at(-1) - 3, width: 6, height: 6, class: 'theme-circuit-node' }, circuit);
    if (i < 5) svg('rect', { x: points[4] - 3, y: points[5] - 3, width: 6, height: 6, class: 'theme-circuit-node' }, circuit);
  });
}

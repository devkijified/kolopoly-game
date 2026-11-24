'use strict';
// Original Lagos sticker drawings. Bold shapes, dark outline, warm
// palette. No real brand marks.
(function () {
  const ink = '#1c140c';
  function svg(body) {
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(32 32) scale(1.28) translate(-32 -32)">' + body + '</g></svg>';
  }
  const S = (d) => '<path fill="' + d.fill + '" stroke="' + ink + '" stroke-width="2.2" stroke-linejoin="round" d="' + d.d + '"/>';
  window.KPStickerArt = {
    'lekki-toll': svg(
      S({ fill: '#f6ead2', d: 'M6 50h52v8H6z' }) +
      S({ fill: '#e8a317', d: 'M14 28h8v22h-8zM42 28h8v22h-8z' }) +
      S({ fill: '#c4552a', d: 'M10 24h44v6H10z' }) +
      S({ fill: '#9c2b3a', d: 'M18 24l16-10 4 4-16 10z' })
    ),
    carter: svg(
      S({ fill: '#2f6f8f', d: 'M4 40c8 8 16 8 24 0s16-8 28 0v10H4z' }) +
      S({ fill: '#e7d3a1', d: 'M8 36c6-10 14-10 20 0 6-10 14-10 20 0v6H8z' }) +
      S({ fill: '#8a5a2b', d: 'M16 36v-8h4v8zM44 36v-8h4v8z' })
    ),
    'third-mainland': svg(
      S({ fill: '#2f6f8f', d: 'M0 44h64v12H0z' }) +
      S({ fill: '#d8d0c4', d: 'M0 34h64v8H0z' }) +
      S({ fill: '#8a5a2b', d: 'M10 34V22h4v12zM30 34V18h4v16zM50 34V22h4v12z' }) +
      S({ fill: '#e8a317', d: 'M8 22h8v4H8zM28 18h8v4h-8zM48 22h8v4h-8z' })
    ),
    balogun: svg(
      S({ fill: '#c4552a', d: 'M6 28h16v20H6z' }) +
      S({ fill: '#1f7a45', d: 'M24 24h16v24H24z' }) +
      S({ fill: '#e8a317', d: 'M42 30h16v18H42z' }) +
      S({ fill: '#f6ead2', d: 'M4 22h20l-2 6H6zM22 16h20l-2 8H24zM40 22h20l-2 8H42z' })
    ),
    suya: svg(
      S({ fill: '#5c3317', d: 'M10 40h44v8H10z' }) +
      S({ fill: '#e25b4a', d: 'M16 28c0-6 4-8 4-8s4 2 4 8v12h-8zM28 26c0-7 4-10 4-10s4 3 4 10v14h-8zM40 30c0-5 4-8 4-8s4 3 4 8v10h-8z' }) +
      S({ fill: '#f6ead2', d: 'M18 18v-8M32 14V6M44 20v-8' })
    ),
    'computer-village': svg(
      S({ fill: '#243044', d: 'M8 18h48v28H8z' }) +
      S({ fill: '#7eb6ff', d: 'M14 24h14v10H14zM36 24h14v10H36z' }) +
      S({ fill: '#e8a317', d: 'M18 40h8v6h-8zM38 40h8v6h-8z' }) +
      S({ fill: '#f6ead2', d: 'M20 16h24v4H20z' })
    ),
    tbs: svg(
      S({ fill: '#e7d3a1', d: 'M8 18h48v30H8z' }) +
      S({ fill: '#9c2b3a', d: 'M28 8h8v12h-8z' }) +
      S({ fill: '#1f7a45', d: 'M14 28h10v12H14zM40 28h10v12H40z' }) +
      S({ fill: '#e8a317', d: 'M30 28h4v20h-4z' })
    ),
    'national-theatre': svg(
      S({ fill: '#c4552a', d: 'M8 36 L32 12 L56 36 V52 H8z' }) +
      S({ fill: '#f6ead2', d: 'M22 36h20v16H22z' }) +
      S({ fill: '#e8a317', d: 'M28 20h8v8h-8z' })
    ),
    'eko-atlantic': svg(
      S({ fill: '#2f6f8f', d: 'M0 46h64v12H0z' }) +
      S({ fill: '#d8d0c4', d: 'M10 28h8v18h-8zM22 18h10v28H22zM36 24h8v22h-8zM48 14h8v32h-8z' }) +
      S({ fill: '#e8a317', d: 'M24 18h6v4h-6zM50 14h4v4h-4z' })
    ),
    danfo: svg(
      S({ fill: '#f0c14a', d: 'M8 24h40l6 8v12H8z' }) +
      S({ fill: '#7eb6ff', d: 'M14 28h10v8H14zM28 28h12v8H28z' }) +
      S({ fill: '#1c140c', d: 'M14 46a4 4 0 1 0 .1 0zM40 46a4 4 0 1 0 .1 0z' }) +
      S({ fill: '#9c2b3a', d: 'M8 24h10v6H8z' })
    ),
    molue: svg(
      S({ fill: '#f4e4c4', d: 'M6 20h46l6 10v16H6z' }) +
      S({ fill: '#2f6f8f', d: 'M12 26h8v8h-8zM24 26h8v8h-8zM36 26h8v8h-8z' }) +
      S({ fill: '#1c140c', d: 'M14 48a5 5 0 1 0 .1 0zM42 48a5 5 0 1 0 .1 0z' })
    ),
    okada: svg(
      S({ fill: '#1f7a45', d: 'M18 30h16l6 6H22z' }) +
      S({ fill: '#1c140c', d: 'M16 40a7 7 0 1 0 .1 0zM44 40a7 7 0 1 0 .1 0z' }) +
      S({ fill: '#e8a317', d: 'M30 22h6v8h-6z' }) +
      S({ fill: '#9c2b3a', d: 'M22 24h10v4H22z' })
    ),
    kirikiri: svg(
      S({ fill: '#8a8f98', d: 'M14 10h6v40h-6zM29 10h6v40h-6zM44 10h6v40h-6z' }) +
      S({ fill: '#5c3317', d: 'M8 46h48v6H8z' }) +
      S({ fill: '#e8a317', d: 'M24 22h16v10H24z' })
    ),
    'owambe-hall': svg(
      S({ fill: '#9c2b3a', d: 'M10 28h44v22H10z' }) +
      S({ fill: '#f6ead2', d: 'M8 24h48l-4 6H12z' }) +
      S({ fill: '#e8a317', d: 'M6 18h8l-2 8H8zM28 14h8l-2 12h-4zM50 18h8l-2 8h-4z' }) +
      S({ fill: '#1f7a45', d: 'M22 36h8v14h-8zM34 36h8v14h-8z' })
    ),
    'marina-lights': svg(
      S({ fill: '#243044', d: 'M0 48h64v10H0z' }) +
      S({ fill: '#2f6f8f', d: 'M0 40c10 6 18 6 28 0s18-6 36 0v8H0z' }) +
      S({ fill: '#e8a317', d: 'M12 18h4v22h-4zM30 12h4v28h-4zM48 18h4v22h-4z' }) +
      S({ fill: '#fff4c8', d: 'M10 14h8v6h-8zM28 8h8v6h-8zM46 14h8v6h-8z' })
    )
  };
})();

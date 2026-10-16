// Pixel art engine: every sprite in the app is drawn here at native resolution (planets ~128px, icons 24px,
// sky scenes) with palette ramps, ordered dithering and 1px ink outlines, then shown scaled up with
// image-rendering: pixelated. Results are cached as data URLs.
(function (root) {
  'use strict';
  const INK = '#241a33';
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hashStr = (s) => [...String(s)].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);

  // smooth value noise + fbm
  function noise2(seed) {
    const h = (x, y) => {
      let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const sm = (t) => t * t * (3 - 2 * t);
    const n = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
      const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
    return (x, y, oct = 4) => {
      let v = 0, amp = 0.5, f = 1, tot = 0;
      for (let i = 0; i < oct; i++) { v += amp * n(x * f, y * f); tot += amp; amp *= 0.5; f *= 2; }
      return v / tot;
    };
  }

  // pick a colour from a ramp with ordered dithering between neighbours
  function ramp(colors, t, x, y) {
    const f = clamp(t) * (colors.length - 1);
    const i = Math.floor(f);
    if (i >= colors.length - 1) return colors[colors.length - 1];
    return f - i > bayer(x, y) ? colors[i + 1] : colors[i];
  }

  class Px {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
    set(x, y, c) { x = Math.floor(x); y = Math.floor(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.d[y * this.w + x] : null; }
    rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); return this; }
    // rect with light top/left and dark bottom/right edges
    bevel(x, y, w, h, base, light, dark) {
      this.rect(x, y, w, h, base);
      this.rect(x, y, w, 1, light); this.rect(x, y, 1, h, light);
      this.rect(x, y + h - 1, w, 1, dark); this.rect(x + w - 1, y, 1, h, dark);
      return this;
    }
    ellipse(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
        for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) this.set(x, y, typeof c === 'function' ? c(x, y, dx, dy) : c);
        }
      return this;
    }
    circle(cx, cy, r, c) { return this.ellipse(cx, cy, r, r, c); }
    line(x0, y0, x1, y1, c) {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.set(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      return this;
    }
    blit(src, ox, oy) { for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const c = src.d[y * src.w + x]; if (c) this.set(ox + x, oy + y, c); } return this; }
    // 1px outline around every filled region (4-neighbour), the signature pixel-art edge
    outline(c = INK) {
      const add = [];
      for (let y = 0; y < this.h; y++)
        for (let x = 0; x < this.w; x++)
          if (!this.get(x, y) && (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1))) add.push([x, y]);
      for (const [x, y] of add) this.set(x, y, c);
      return this;
    }
    url() {
      const cv = document.createElement('canvas');
      cv.width = this.w; cv.height = this.h;
      const g = cv.getContext('2d');
      const img = g.createImageData(this.w, this.h);
      for (let i = 0; i < this.d.length; i++) {
        const c = this.d[i];
        if (!c) continue;
        const n = parseInt(c.slice(1), 16);
        img.data[i * 4] = n >> 16; img.data[i * 4 + 1] = (n >> 8) & 255; img.data[i * 4 + 2] = n & 255; img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return cv.toDataURL('image/png');
    }
  }

  /* ---------------------------------------------------------------- planets */
  const RAMPS = {
    mercury: ['#1e1828', '#3a3044', '#5a4e5e', '#7d7078', '#a39590', '#c9bcae', '#efe4d2'],
    neptune: ['#0b1440', '#122a74', '#1b44a8', '#2667d4', '#3f8ff0', '#73bdfb', '#bfe6ff', '#f2fbff'],
    saturn: ['#2e1a14', '#5a3221', '#8a532d', '#bb7e3c', '#e0a955', '#f5cf7d', '#fff0bf'],
    mars: ['#2a0f14', '#56191c', '#8a2a22', '#bf4a2c', '#e0703e', '#f5a066', '#ffd2a1'],
    jupiter: ['#2a1a16', '#56362a', '#8a5a3c', '#bf8a5a', '#e3b78a', '#f6dcb8', '#fff6e6'],
    earth: ['#0a1f45', '#123c7a', '#1d5fb3', '#2f8ae0', '#5fb6f5', '#a9dcff', '#ffffff'],
    land: ['#14361f', '#1f5a2c', '#2f8a3b', '#58b34a', '#95d36a', '#d6ef9e'],
    uranus: ['#0e3340', '#145a6b', '#1c8496', '#33b3bf', '#6ad8d6', '#b5f2e8', '#effffb'],
    venus: ['#3a2010', '#6b3f1c', '#a0662a', '#cf9443', '#ecc070', '#fbe3a6', '#fff8e0'],
    ring: ['#3d2a1c', '#6b5034', '#9c7c52', '#c9a974', '#ead29c', '#fff3d1'],
    luna: ['#1f1d24', '#3b3842', '#5c5862', '#827d84', '#aaa4a6', '#d0cbc8', '#f2eee8'],
    rock: ['#1e1612', '#3a2a22', '#5a4334', '#7a5e4a', '#9c7d66', '#c2a58c', '#e2cdb6'],
    io: ['#3a2a08', '#6e4f10', '#a87a18', '#d6aa2a', '#f0d050', '#fbea8c', '#fffbd0'],
    europa: ['#3a2c22', '#6b5644', '#a08c78', '#cbbca8', '#e8ddcc', '#fbf5ec', '#ffffff'],
    ganymede: ['#1e1a1a', '#3c3532', '#5e5450', '#857a72', '#ada196', '#d4cbbf', '#f0ebe4'],
    callisto: ['#120e0c', '#2a211c', '#44372e', '#614f42', '#86705c', '#b09a84', '#e0d2c0'],
    titan: ['#3a1e08', '#6b3a10', '#a05a18', '#cf8a2a', '#ecb450', '#f8d888', '#fff2cc'],
    enceladus: ['#43566a', '#6e8499', '#9cb2c6', '#c6d8e8', '#e6f1fa', '#ffffff'],
    icy: ['#2e2e38', '#4c4c58', '#70707e', '#9898a6', '#c0c0cc', '#e2e2ea', '#ffffff'],
    triton: ['#4a3036', '#7a5458', '#a8807e', '#d0aca4', '#ecd2c8', '#fff0ea'],
    pluto: ['#3a2418', '#6b4430', '#9c6c4c', '#c89a72', '#e8c4a0', '#fbe6cc', '#fff8ee'],
  };
  // every world a build can be named after: key, display name, what it is
  const WORLDS = [
    ['mercury', 'Mercury', 'planet'], ['venus', 'Venus', 'planet'], ['earth', 'Earth', 'planet'], ['mars', 'Mars', 'planet'], ['jupiter', 'Jupiter', 'planet'],
    ['saturn', 'Saturn', 'planet'], ['uranus', 'Uranus', 'planet'], ['neptune', 'Neptune', 'planet'], ['pluto', 'Pluto', 'dwarf planet'],
    ['luna', 'Luna', "Earth's moon"], ['phobos', 'Phobos', 'moon of Mars'], ['deimos', 'Deimos', 'moon of Mars'],
    ['io', 'Io', 'moon of Jupiter'], ['europa', 'Europa', 'moon of Jupiter'], ['ganymede', 'Ganymede', 'moon of Jupiter'], ['callisto', 'Callisto', 'moon of Jupiter'],
    ['titan', 'Titan', 'moon of Saturn'], ['enceladus', 'Enceladus', 'moon of Saturn'], ['mimas', 'Mimas', 'moon of Saturn'], ['rhea', 'Rhea', 'moon of Saturn'],
    ['dione', 'Dione', 'moon of Saturn'], ['tethys', 'Tethys', 'moon of Saturn'], ['iapetus', 'Iapetus', 'moon of Saturn'],
    ['miranda', 'Miranda', 'moon of Uranus'], ['ariel', 'Ariel', 'moon of Uranus'], ['titania', 'Titania', 'moon of Uranus'], ['oberon', 'Oberon', 'moon of Uranus'],
    ['triton', 'Triton', 'moon of Neptune'], ['charon', 'Charon', 'moon of Pluto'],
  ];
  // which palette + texture a world uses
  const LOOK = {phobos: 'rock', deimos: 'rock', mimas: 'icy', rhea: 'icy', dione: 'icy', tethys: 'icy', miranda: 'icy', ariel: 'icy', titania: 'icy', oberon: 'icy', charon: 'icy', iapetus: 'icy'};
  const CRATERS = {mercury: 26, mars: 9, luna: 22, rock: 18, callisto: 46, ganymede: 12, icy: 24, pluto: 4, triton: 3};
  const SMALL = new Set(['phobos', 'deimos', 'mimas', 'miranda', 'enceladus']);
  const GENERIC = ['mars', 'jupiter', 'earth', 'uranus', 'venus'];
  // a build named after a planet or moon gets that world; anything else gets a planet picked from its name
  const kindFor = (b) => {
    const k = `${b.name || ''} ${b.id || ''}`.toLowerCase();
    if (/\b(moon|luna)\b/.test(k)) return 'luna';
    const hit = WORLDS.find(([w]) => w !== 'luna' && new RegExp(`\\b${w}\\b`).test(k));
    return hit ? hit[0] : GENERIC[hashStr(String(b.id || b.name || '').toLowerCase()) % GENERIC.length];
  };

  // shaded sphere of radius r, drawn into px at (cx, cy)
  function sphere(px, cx, cy, r, kind, seed) {
    const n = noise2(seed);
    const look = LOOK[kind] || kind;
    const R = RAMPS[look] || RAMPS.mars;
    const L = [-0.55, -0.62, 0.56];
    const ll = Math.hypot(...L);
    const craters = [];
    if (CRATERS[look]) {
      const rnd = rng(seed + 7);
      const big = look === 'callisto' ? 0.1 : look === 'mars' || look === 'pluto' || look === 'triton' ? 0.14 : 0.22;
      for (let i = 0; i < CRATERS[look]; i++) craters.push([rnd() * 2 - 1, rnd() * 2 - 1, 0.04 + rnd() ** 2 * big]);
      if (kind === 'mimas') craters.push([0.3, 0.05, 0.42]); // Herschel, the "Death Star" crater
    }
    const crater = (u, v) => {
      let a = 0;
      for (const [cu, cv, cr] of craters) {
        const dd = Math.hypot(u - cu, v - cv) / cr;
        if (dd < 1) {
          // bowl is shadowed on the lit side, rim catches light on the far side
          const side = ((u - cu) * -L[0] + (v - cv) * -L[1]) / cr;
          a += dd < 0.78 ? -0.16 + side * 0.18 : 0.12;
        }
      }
      return a;
    };
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        const lam = clamp((nx * L[0] + ny * L[1] + nz * L[2]) / ll);
        // texture coordinates that wrap a little around the sphere
        const u = nx / (0.6 + 0.4 * nz), v = ny;
        let alb = 0.62, ramp_ = R, light = lam;
        if (kind === 'mercury' || kind === 'mars') {
          alb = 0.5 + (n(u * 3 + 10, v * 3, 5) - 0.5) * 0.7 + crater(u, v);
          if (kind === 'mars') alb += ny < -0.82 ? 0.35 : 0; // polar cap
        } else if (kind === 'luna') {
          // dark basalt "seas" over bright highlands
          const mare = n(u * 1.6 + 30, v * 1.6, 4);
          alb = (mare > 0.55 ? 0.4 : 0.7) + (n(u * 6, v * 6, 3) - 0.5) * 0.15 + crater(u, v);
        } else if (look === 'rock') {
          alb = 0.5 + (n(u * 4 + 50, v * 4, 4) - 0.5) * 0.5 + crater(u, v) * (kind === 'deimos' ? 0.5 : 1);
        } else if (look === 'icy') {
          alb = 0.66 + (n(u * 4 + 70, v * 4, 4) - 0.5) * 0.25 + crater(u, v);
          if (kind === 'iapetus' && u < -0.05 + (n(v * 3, 9, 2) - 0.5) * 0.4) { ramp_ = RAMPS.rock; alb = 0.32; } // two-toned: one dark side
          if (kind === 'charon' && ny + (n(u * 5, 3, 2) - 0.5) * 0.35 < -0.62) { ramp_ = RAMPS.mars; alb = 0.38; } // ragged red north pole
          if (kind === 'miranda') alb += Math.sin(u * 14 + v * 6) > 0.6 ? -0.15 : 0; // patchwork grooves
        } else if (kind === 'io') {
          alb = 0.6 + (n(u * 3 + 5, v * 3, 4) - 0.5) * 0.4;
          const spot = n(u * 7 + 11, v * 7, 2);
          if (spot > 0.7) { ramp_ = RAMPS.mars; alb = 0.45; } // volcanoes and red sulfur
          else if (spot < 0.22) alb -= 0.3;
        } else if (kind === 'europa') {
          alb = 0.78 + (n(u * 3, v * 3, 3) - 0.5) * 0.15;
          const crack = Math.abs(n(u * 5 + 2, v * 5, 4) - 0.5);
          if (crack < 0.025) { ramp_ = RAMPS.mars; alb = 0.62; } // reddish lineae across the ice
        } else if (kind === 'ganymede') {
          alb = (n(u * 2 + 40, v * 2, 4) > 0.5 ? 0.66 : 0.42) + Math.sin((u + v) * 30) * 0.04 + crater(u, v);
        } else if (kind === 'callisto') {
          alb = 0.4 + (n(u * 5, v * 5, 3) - 0.5) * 0.2 + Math.max(0, crater(u, v)) * 2.2;
        } else if (kind === 'titan') {
          alb = 0.58 + Math.sin(v * 4 + (n(u * 2, v * 3, 3) - 0.5) * 2) * 0.06; // smooth orange haze
        } else if (kind === 'enceladus') {
          alb = 0.85 + (n(u * 5, v * 5, 3) - 0.5) * 0.1;
          if (v > 0.45 && Math.abs(Math.sin(u * 9 + v * 2)) < 0.12) { ramp_ = RAMPS.neptune; alb = 0.7; } // blue "tiger stripes"
        } else if (kind === 'triton') {
          alb = 0.62 + (n(u * 8, v * 8, 2) - 0.5) * 0.3 + crater(u, v); // "cantaloupe" terrain
          if (ny > 0.35) alb += 0.25; // bright southern cap
        } else if (kind === 'pluto') {
          alb = 0.55 + (n(u * 3 + 80, v * 3, 4) - 0.5) * 0.35 + crater(u, v);
          // the heart (Tombaugh Regio): two lobes and a point
          const hx = u - 0.1, hy = v - 0.12;
          const heart = Math.hypot(hx + 0.13, hy + 0.08) < 0.2 || Math.hypot(hx - 0.13, hy + 0.08) < 0.2 || (hy > -0.05 && hy < 0.3 && Math.abs(hx) < 0.3 - hy);
          if (heart) alb = 1.02;
          if (Math.hypot((u + 0.62) / 0.3, (v - 0.1) / 0.24) + (n(u * 6, v * 6, 2) - 0.5) * 0.6 < 1) { ramp_ = RAMPS.rock; alb = 0.32; } // dark Cthulhu region
        } else if (kind === 'neptune') {
          const band = Math.sin(v * 9 + (n(u * 2, v * 6, 3) - 0.5) * 3.2);
          alb = 0.55 + band * 0.12;
          const spot = Math.hypot((u + 0.28) / 0.26, (v - 0.18) / 0.12);
          if (spot < 1) alb -= 0.32 * (1 - spot * 0.6);
          const cloud = n(u * 5 + 3, v * 16, 3);
          if (cloud > 0.66 && Math.abs(v + 0.32) < 0.12) alb = 1.2; // bright cirrus streaks
          if (cloud > 0.7 && Math.abs(v - 0.42) < 0.06) alb = 1.1;
        } else if (kind === 'saturn' || kind === 'jupiter') {
          const wob = (n(u * 3, v * 10, 3) - 0.5) * (kind === 'jupiter' ? 1.6 : 0.6);
          alb = 0.55 + Math.sin(v * (kind === 'jupiter' ? 13 : 11) + wob) * 0.17 + Math.sin(v * 31 + wob * 2) * 0.06;
          if (kind === 'jupiter') {
            const spot = Math.hypot((u - 0.25) / 0.24, (v - 0.32) / 0.12);
            if (spot < 1) { ramp_ = RAMPS.mars; alb = 0.62; }
          }
        } else if (kind === 'earth') {
          const land = n(u * 2.2 + 4, v * 2.2, 5);
          if (land > 0.53) { ramp_ = RAMPS.land; alb = 0.45 + (land - 0.53) * 2; }
          else alb = 0.45;
          if (n(u * 4 + 20, v * 7, 4) > 0.62 || Math.abs(ny) > 0.88) { ramp_ = R; alb = 1.15; }
        } else if (kind === 'uranus') {
          alb = 0.6 + Math.sin(v * 5) * 0.04;
        } else if (kind === 'venus') {
          alb = 0.55 + (n(u * 2 + Math.sin(v * 3), v * 6, 4) - 0.5) * 0.6;
        }
        // light: ambient + diffuse, a cool rim on the dark limb, bright specular dot
        let t = alb * (0.16 + 0.95 * Math.pow(light, 0.85));
        const rim = Math.pow(1 - nz, 3) * (1 - light);
        t += rim * 0.25;
        if (light > 0.97) t += 0.12;
        px.set(x, y, ramp(ramp_, t, x, y));
      }
  }

  function planet(kind, size, seed = 1) {
    const ringed = kind === 'saturn' || kind === 'uranus';
    const r = ringed ? size * 0.235 : SMALL.has(kind) ? size * 0.36 : size * 0.44;
    const W = size, H = size, cx = W / 2, cy = H / 2;
    const px = new Px(W, H);
    const RR = RAMPS.ring;
    const ringPx = (front) => {
      const tilt = kind === 'uranus' ? 0.18 : 0.34;
      const inner = r * (kind === 'uranus' ? 1.45 : 1.3), outer = r * (kind === 'uranus' ? 1.62 : 2.05);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) / tilt;
          const d = Math.hypot(dx, dy);
          if (d < inner || d > outer) continue;
          if (front !== dy > 0) continue;
          const f = (d - inner) / (outer - inner);
          if (kind === 'saturn' && f > 0.6 && f < 0.67) continue; // Cassini division
          let t = kind === 'uranus' ? 0.75 : 0.35 + Math.sin(f * 21) * 0.12 + f * 0.25;
          t *= 0.7 + 0.45 * clamp(0.5 - dx / outer);
          // planet's shadow falls on the ring behind it, away from the light
          if (!front && Math.abs(dx - r * 0.35) < r * 0.9 && dy < 0) t *= 0.45;
          px.set(x, y, ramp(kind === 'uranus' ? RAMPS.uranus : RR, t, x, y));
        }
    };
    if (ringed) ringPx(false);
    // back half of the ring first, then the planet, then the front half over it
    sphere(px, cx, cy, r, kind, seed);
    if (ringed) ringPx(true);
    return px.outline();
  }

  /* ---------------------------------------------------------------- sky scenes */
  const SKY = {
    light: {
      grad: ['#3fa8ff', '#5cb8ff', '#7ecbff', '#a2dbff', '#c8eaff', '#e9f6ff', '#fff4dc'],
      cloud: ['#b9dcf5', '#dbeefc', '#ffffff'], spark: '#ffffff',
    },
    dark: {
      grad: ['#0c0a22', '#14113a', '#1d1850', '#2a2068', '#3a2a7c', '#56308a'],
      neb: ['#4a2a86', '#7a3a9c', '#b04aa0'], stars: ['#ffffff', '#fff1a8', '#a8f0ff', '#ffc3ee'],
    },
  };
  function sky(w, h, theme, seed = 3) {
    const px = new Px(w, h);
    const P = SKY[theme] || SKY.light;
    const n = noise2(seed);
    const rnd = rng(seed);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const t = y / (h - 1) + (n(x / 40, y / 40, 2) - 0.5) * 0.12;
        px.set(x, y, ramp(P.grad, t, x, y));
        if (theme === 'dark') {
          const neb = n(x / 55 + 9, y / 26, 5);
          if (neb > 0.56) px.set(x, y, ramp(P.neb, (neb - 0.56) * 4, x, y));
        }
      }
    if (theme === 'dark') {
      for (let i = 0; i < (w * h) / 60; i++) {
        const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
        px.set(x, y, P.stars[Math.floor(rnd() * P.stars.length)]);
      }
      for (let i = 0; i < w / 30; i++) sparkle(px, Math.floor(rnd() * w), Math.floor(rnd() * h), rnd() > 0.6 ? 3 : 2, P.stars[Math.floor(rnd() * 4)]);
    } else {
      // puffy clouds: overlapping circles, shaded underside, soft outline
      for (let i = 0; i < Math.max(2, w / 70); i++) {
        const cx = rnd() * w, cy = h * (0.35 + rnd() * 0.5), s = 4 + rnd() * 6;
        const cl = new Px(w, h);
        for (let k = 0; k < 5; k++) cl.circle(cx + (k - 2) * s * 0.9, cy - (k % 2 ? s * 0.45 : 0) - (k === 2 ? s * 0.4 : 0), s * (k === 2 ? 1.25 : 0.95), (x, y) => (y > cy + s * 0.25 ? P.cloud[0] : y > cy - s * 0.3 ? P.cloud[1] : P.cloud[2]));
        cl.rect(Math.floor(cx - s * 2.6), Math.floor(cy + s * 0.55), Math.ceil(s * 5.2), 50, null);
        cl.outline('#8cc4ea');
        px.blit(cl, 0, 0);
      }
      for (let i = 0; i < w / 45; i++) sparkle(px, Math.floor(rnd() * w), Math.floor(rnd() * h * 0.6), 2, P.spark);
    }
    return px;
  }
  function sparkle(px, x, y, s, c) {
    for (let i = -s; i <= s; i++) { px.set(x + i, y, c); px.set(x, y + i, c); }
  }

  /* ---------------------------------------------------------------- icons (24 x 24) */
  const C = {
    pcb: ['#2a8a5a', '#43b97a', '#1d6b45'], gold: ['#ffd34d', '#fff1a6', '#c9921f'], silver: ['#cfd5e3', '#ffffff', '#8e97ad'],
    dark: ['#33304a', '#4c4868', '#211e33'], pink: '#ff4f8b', yellow: '#ffcf3f', blue: '#4fb3ff', mint: '#3fd9a5', purple: '#9b6bff', orange: '#ff8a3d',
  };
  const ICONS = {
    CPU(p) {
      p.bevel(3, 3, 18, 18, C.pcb[0], C.pcb[1], C.pcb[2]);
      for (let i = 5; i < 19; i += 2) { p.set(i, 4, C.gold[0]); p.set(i, 19, C.gold[0]); p.set(4, i, C.gold[0]); p.set(19, i, C.gold[0]); }
      p.bevel(7, 7, 10, 10, C.silver[0], C.silver[1], C.silver[2]);
      p.rect(9, 9, 3, 1, C.silver[1]); p.set(9, 10, C.silver[1]);
      p.set(6, 17, C.yellow); p.set(6, 16, C.yellow); p.set(7, 17, C.yellow);
    },
    RAM(p) {
      p.bevel(1, 7, 22, 10, C.pcb[0], C.pcb[1], C.pcb[2]);
      for (const x of [3, 8, 13, 18]) { p.bevel(x, 9, 4, 5, C.dark[0], C.dark[1], C.dark[2]); }
      for (let x = 2; x < 22; x += 2) p.set(x, 16, C.gold[0]);
      p.set(12, 16, null); p.set(12, 15, null);
      p.rect(1, 6, 22, 1, C.pink); p.set(2, 6, '#ffa3c4');
    },
    // 3.5" floppy disk: blue shell with a clipped corner, sliding metal shutter, paper label
    Storage(p) {
      p.bevel(2, 2, 20, 20, '#3f8fe8', '#8cc8ff', '#2563b8');
      p.set(21, 2, null); p.set(20, 2, null); p.set(21, 3, null); p.set(20, 3, '#2563b8'); p.set(19, 2, '#8cc8ff');
      p.bevel(7, 2, 10, 7, C.silver[0], C.silver[1], C.silver[2]);
      p.rect(13, 3, 2, 5, C.dark[2]);
      p.bevel(5, 12, 14, 9, '#fff7e6', '#ffffff', '#d9cbb3');
      p.rect(5, 12, 14, 2, C.pink); p.rect(5, 12, 14, 1, '#ff8db3');
      p.rect(7, 15, 10, 1, '#b9add0'); p.rect(7, 17, 7, 1, '#b9add0');
      p.set(3, 19, '#1d4d96'); p.set(3, 20, '#1d4d96');
    },
    GPU(p) {
      p.bevel(1, 6, 19, 11, C.dark[0], C.dark[1], C.dark[2]);
      for (const cx of [6.5, 14.5]) p.circle(cx, 11.5, 4, (x, y) => {
        const a = Math.atan2(y + 0.5 - 11.5, x + 0.5 - cx);
        return (((a / (Math.PI * 2)) * 5 + 10) % 1) < 0.5 ? '#9b6bff' : '#d9c7ff';
      });
      p.set(6, 11, C.yellow); p.set(14, 11, C.yellow);
      p.bevel(20, 4, 3, 15, C.silver[0], C.silver[1], C.silver[2]);
      for (let x = 3; x < 13; x += 2) p.set(x, 17, C.gold[0]);
      p.rect(2, 6, 17, 1, C.purple);
    },
    Motherboard(p) {
      p.bevel(2, 2, 20, 20, '#2bb3a3', '#5fe0cf', '#1b7f74');
      p.bevel(5, 5, 7, 7, C.silver[0], C.silver[1], C.silver[2]);
      p.rect(7, 7, 3, 3, C.dark[1]);
      p.rect(14, 4, 2, 9, C.dark[0]); p.rect(17, 4, 2, 9, C.dark[0]);
      p.rect(4, 15, 13, 2, C.dark[0]); p.rect(4, 18, 9, 2, C.dark[0]);
      for (const [x, y] of [[19, 16], [19, 18], [15, 19]]) p.set(x, y, C.yellow);
      p.line(12, 8, 13, 8, '#a6f2e8');
    },
    Power(p) {
      p.bevel(2, 5, 20, 15, '#8790b0', '#c3cae0', '#555d7c');
      p.circle(9.5, 12.5, 5.5, C.dark[0]);
      p.circle(9.5, 12.5, 3.5, C.dark[1]);
      p.circle(9.5, 12.5, 1.5, C.silver[0]);
      const bolt = [[18, 7], [17, 8], [16, 9], [17, 9], [18, 9], [17, 10], [16, 11], [15, 12], [16, 12], [17, 12], [16, 13], [15, 14], [14, 15]];
      for (const [x, y] of bolt) p.set(x, y, C.yellow);
      p.set(18, 8, C.yellow);
    },
    Cooling(p) {
      p.bevel(2, 2, 20, 20, '#6dd3ff', '#bdeeff', '#2c93c9');
      p.circle(12, 12, 9, '#1e4a66');
      p.circle(12, 12, 8, (x, y) => {
        const dx = x + 0.5 - 12, dy = y + 0.5 - 12, a = Math.atan2(dy, dx), r = Math.hypot(dx, dy);
        return (((a / (Math.PI * 2)) * 5 + r * 0.07 + 10) % 1) < 0.48 ? '#ecf9ff' : '#2b6c90';
      });
      p.circle(12, 12, 2, C.yellow);
      for (const [x, y] of [[3, 3], [20, 3], [3, 20], [20, 20]]) p.set(x, y, '#2c93c9');
    },
    Network(p) {
      p.bevel(1, 7, 16, 10, C.pcb[0], C.pcb[1], C.pcb[2]);
      p.bevel(16, 5, 7, 10, C.silver[0], C.silver[1], C.silver[2]);
      p.rect(17, 8, 5, 5, C.dark[2]); p.rect(18, 12, 3, 1, C.dark[0]);
      p.set(17, 6, C.mint); p.set(21, 6, C.orange);
      p.bevel(4, 9, 6, 5, C.dark[0], C.dark[1], C.dark[2]);
      for (let x = 3; x < 15; x += 2) p.set(x, 16, C.gold[0]);
    },
    Case(p) {
      p.bevel(6, 1, 12, 22, '#b79cff', '#e2d6ff', '#7b5fd1');
      p.rect(8, 4, 8, 2, '#7b5fd1'); p.rect(8, 7, 8, 2, '#7b5fd1');
      p.circle(12, 13, 2, C.pink); p.set(11, 12, '#ffb3cd');
      for (let y = 17; y < 21; y += 2) for (let x = 8; x < 16; x += 2) p.set(x, y, '#7b5fd1');
    },
    System(p) {
      p.bevel(1, 3, 22, 14, C.dark[0], C.dark[1], C.dark[2]);
      p.bevel(3, 5, 18, 10, C.blue, '#a6dcff', '#2b7fd0');
      p.rect(5, 7, 6, 1, '#ffffff'); p.rect(5, 9, 9, 1, '#d6efff'); p.rect(5, 11, 4, 1, C.mint);
      p.rect(9, 17, 6, 3, C.dark[1]); p.bevel(5, 20, 14, 2, C.silver[0], C.silver[1], C.silver[2]);
    },
    // microcontroller board: red LaunchPad-style PCB, header rows top and bottom, MCU, USB, a lit LED
    'Dev Board'(p) {
      p.bevel(2, 5, 20, 14, '#e8443a', '#ff8a7a', '#a8241c');
      for (let x = 4; x < 20; x += 2) { p.set(x, 6, C.dark[2]); p.set(x, 17, C.dark[2]); p.set(x + 1, 6, C.gold[0]); p.set(x + 1, 17, C.gold[0]); }
      p.bevel(9, 9, 6, 6, C.dark[0], C.dark[1], C.dark[2]);
      for (let i = 10; i < 14; i += 2) { p.set(8, i, C.silver[0]); p.set(15, i, C.silver[0]); }
      p.bevel(0, 10, 4, 4, C.silver[0], C.silver[1], C.silver[2]);
      p.set(18, 10, C.mint); p.set(18, 12, C.yellow);
      p.set(5, 9, '#ffc0b8'); p.set(6, 9, '#ffc0b8');
    },
    // single-board computer: green PCB, silver SoC, 2-row GPIO header, stacked USB + Ethernet on the right
    SBC(p) {
      p.bevel(1, 3, 20, 18, C.pcb[0], C.pcb[1], C.pcb[2]);
      for (let x = 3; x < 15; x++) { p.set(x, 4, x % 2 ? C.gold[0] : C.dark[2]); p.set(x, 5, x % 2 ? C.dark[2] : C.gold[0]); }
      p.bevel(4, 9, 7, 7, C.silver[0], C.silver[1], C.silver[2]); p.set(5, 10, '#ffffff');
      p.bevel(13, 9, 3, 5, C.dark[0], C.dark[1], C.dark[2]);
      p.bevel(18, 6, 5, 5, C.silver[0], C.silver[1], C.silver[2]); p.rect(19, 8, 3, 1, C.blue);
      p.bevel(18, 12, 5, 6, C.silver[0], C.silver[1], C.silver[2]); p.rect(19, 14, 3, 2, C.dark[2]);
      p.set(4, 18, C.pink); p.set(6, 18, C.mint);
    },
    // breakout module: small purple board, round sensor, pin row along the bottom
    Module(p) {
      p.bevel(4, 4, 16, 14, '#8a5cf0', '#c2a8ff', '#5b37b0');
      p.circle(4.5 + 4, 4 + 5, 2, C.dark[2]); p.circle(19.5 - 4, 4 + 5, 2, C.dark[2]);
      p.bevel(9, 7, 6, 6, C.silver[0], C.silver[1], C.silver[2]); p.circle(12, 10, 1.5, C.dark[1]); p.set(11, 9, '#ffffff');
      p.rect(7, 18, 10, 1, C.dark[2]);
      for (let x = 7; x < 17; x += 2) p.rect(x, 19, 1, 3, C.gold[0]);
      p.set(17, 15, C.yellow);
    },
    Other(p) {
      p.circle(12, 12, 8, C.yellow);
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; p.rect(Math.round(12 + Math.cos(a) * 9) - 1, Math.round(12 + Math.sin(a) * 9) - 1, 3, 3, C.yellow); }
      p.circle(12, 12, 3.5, '#c9921f'); p.circle(12, 12, 2, null);
      p.set(8, 8, '#fff1a6'); p.set(9, 7, '#fff1a6');
    },
    // app logo: a crate overflowing with parts
    logo(p) {
      p.bevel(3, 8, 9, 3, C.pcb[0], C.pcb[1], C.pcb[2]); for (let x = 4; x < 11; x += 2) p.set(x, 10, C.gold[0]);
      p.bevel(12, 4, 8, 8, C.silver[0], C.silver[1], C.silver[2]); p.rect(14, 6, 4, 4, C.pink);
      p.bevel(2, 11, 20, 11, '#ff9f43', '#ffd09a', '#c76a1c');
      p.rect(3, 14, 18, 1, '#c76a1c'); p.rect(3, 18, 18, 1, '#c76a1c');
      p.rect(5, 12, 2, 9, '#e8852f'); p.rect(17, 12, 2, 9, '#e8852f');
      sparkle(p, 6, 3, 2, C.yellow);
    },
    sun(p) {
      p.circle(12, 12, 5, C.yellow); p.set(10, 10, '#fff7c2'); p.set(10, 11, '#fff7c2'); p.set(11, 10, '#fff7c2');
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; p.line(Math.round(12 + Math.cos(a) * 7.5), Math.round(12 + Math.sin(a) * 7.5), Math.round(12 + Math.cos(a) * 9.5), Math.round(12 + Math.sin(a) * 9.5), C.orange); }
    },
    moon(p) {
      p.circle(12, 12, 8, '#fff1a6'); p.circle(15.5, 9.5, 7, null);
      p.set(8, 14, '#e8cf6a'); p.set(9, 16, '#e8cf6a'); p.set(7, 11, '#e8cf6a');
      sparkle(p, 18, 17, 2, '#ffffff');
    },
    coin(p) {
      p.circle(12, 12, 9, C.gold[0]); p.circle(12, 12, 7, '#ffe27a');
      const S = ['.###.', '#....', '.##..', '...#.', '###..'];
      S.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && p.set(10 + x, 9 + y, '#c9921f')));
      p.rect(12, 8, 1, 7, '#c9921f');
      p.set(7, 8, '#fff6c9'); p.set(8, 7, '#fff6c9'); p.set(7, 9, '#fff6c9');
    },
    rocket(p) {
      p.ellipse(12, 10, 4.5, 8.5, '#f2f4fa');
      p.rect(9, 3, 6, 2, C.pink); p.set(11, 1, C.pink); p.set(12, 1, C.pink); p.rect(10, 2, 4, 1, C.pink);
      p.circle(12, 9, 2.2, C.blue); p.set(11, 8, '#ffffff');
      p.rect(7, 13, 2, 5, C.pink); p.rect(15, 13, 2, 5, C.pink); p.rect(8, 12, 1, 1, C.pink); p.rect(15, 12, 1, 1, C.pink);
      p.rect(10, 18, 4, 2, C.orange); p.rect(11, 20, 2, 2, C.yellow); p.set(11, 22, C.yellow);
      p.rect(9, 6, 1, 8, '#c9cfe0');
    },
    wrench(p) {
      for (let i = 0; i < 11; i++) p.rect(5 + i, 17 - i, 3, 3, i % 3 === 0 ? '#c3cae0' : '#a7b0c8');
      p.circle(17.5, 6.5, 5, '#a7b0c8'); p.circle(19.5, 4.5, 2.6, null); p.set(15, 4, '#e8ecf6'); p.set(14, 5, '#e8ecf6');
      p.rect(4, 17, 4, 4, C.pink); p.rect(4, 17, 4, 1, '#ff8db3');
    },
    camera(p) {
      p.bevel(2, 7, 20, 13, C.dark[0], C.dark[1], C.dark[2]); p.rect(7, 4, 7, 3, C.dark[0]);
      p.circle(12, 13.5, 5, C.silver[2]); p.circle(12, 13.5, 3.6, C.blue); p.circle(12, 13.5, 1.6, '#173f7a'); p.set(10, 12, '#ffffff'); p.set(11, 11, '#d6efff');
      p.rect(17, 9, 3, 2, C.yellow); p.set(4, 9, C.pink);
    },
    trash(p) {
      p.bevel(5, 7, 14, 15, '#9aa3bd', '#d5dbea', '#5f6886');
      for (const x of [8, 11, 14]) p.rect(x, 9, 1, 11, '#5f6886');
      p.bevel(3, 4, 18, 3, '#b8c0d6', '#e8ecf6', '#7a83a0'); p.rect(9, 2, 6, 2, '#7a83a0');
    },
    clock(p) {
      p.circle(12, 12, 9, '#fff7e6'); p.circle(12, 12, 9.5, (x, y, dx, dy) => (dx * dx + dy * dy > 0.78 ? C.purple : '#fff7e6'));
      p.rect(12, 6, 1, 7, C.dark[0]); p.rect(12, 12, 4, 1, C.pink);
      for (const [x, y] of [[12, 4], [20, 12], [12, 20], [4, 12]]) p.set(x, y, C.purple);
      p.set(9, 7, '#ffffff');
    },
    tag(p) {
      // luggage-tag shape: card body with a pointed right end and a punched hole
      p.rect(2, 6, 16, 13, '#fff7e6'); p.rect(2, 6, 16, 1, '#ffffff');
      for (let k = 0; k < 6; k++) p.rect(18 + k, 6 + k, 1, 13 - 2 * k, '#fff7e6');
      const QR = ['1110111', '1010001', '1110101', '0001010', '1011101', '0100011', '1110110'];
      QR.forEach((row, y) => [...row].forEach((c, x) => c === '1' && p.set(5 + x, 8 + y, C.dark[2])));
      p.rect(14, 9, 3, 1, C.pink); p.rect(14, 11, 3, 1, '#b9add0'); p.rect(14, 13, 3, 1, '#b9add0');
      p.circle(19.5, 12.5, 1.3, null);
    },
    search(p) {
      p.circle(10, 10, 7, '#a6dcff'); p.circle(10, 10, 5, '#e6f5ff'); p.set(8, 7, '#ffffff'); p.set(7, 8, '#ffffff');
      for (let i = 0; i < 6; i++) { p.rect(14 + i, 14 + i, 3, 3, C.orange); }
    },
  };

  /* ---------------------------------------------------------------- public api, cached */
  const cache = new Map();
  const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

  const api = {
    icon: (type) => memo(`icon:${type}`, () => {
      const p = new Px(24, 24);
      (ICONS[type] || ICONS.Other)(p);
      return p.outline().url();
    }),
    planet: (build, size = 128) => memo(`planet:${kindFor(build)}:${size}`, () => planet(kindFor(build), size, hashStr(kindFor(build)) % 997).url()),
    kind: kindFor,
    worlds: WORLDS.map(([key, name, what]) => ({key, name, what})),
    world: (b) => { const k = kindFor(b); const w = WORLDS.find(([x]) => x === k); return {key: k, name: w ? w[1] : k, what: w ? w[2] : 'planet', named: !!WORLDS.find(([x]) => x === k && (x === 'luna' ? /\b(moon|luna)\b/i : new RegExp(`\\b${x}\\b`, 'i')).test(`${b.name || ''} ${b.id || ''}`))}; },
    // a wide scene with this build's planet, for the build card banner
    hero: (build, theme, w = 320, h = 112) => memo(`hero:${build.id}:${kindFor(build)}:${theme}:${w}`, () => {
      const kind = kindFor(build);
      const s = sky(w, h, theme, hashStr(build.id) % 9973);
      const size = kind === 'saturn' || kind === 'uranus' ? 128 : 104;
      s.blit(planet(kind, size, hashStr(kind) % 997), w - size - 14, Math.round((h - size) / 2) + (size > h ? 8 : 0));
      return s.url();
    }),
    // header strip with up to three planets, one per build (Mercury/Neptune/Saturn until there are builds)
    // gap = [from, to] in native px: the free stretch of header between the tabs and the buttons
    banner: (w, h, theme, builds = [], gap = [w * 0.45, w * 0.75]) => {
      let kinds = (builds.length ? builds.slice(0, 3).map(kindFor) : ['mercury', 'neptune', 'saturn']);
      const sizeOf = (k, i) => (k === 'saturn' || k === 'uranus' ? 52 : i === 1 ? 38 : 32);
      const span = (ks) => ks.reduce((s, k, i) => s + sizeOf(k, i), 0) + (ks.length - 1) * 12;
      while (kinds.length > 1 && span(kinds) > gap[1] - gap[0]) kinds = kinds.slice(0, -1);
      const from = Math.round(gap[0] + Math.max(0, (gap[1] - gap[0] - span(kinds)) / 2));
      return memo(`banner:${w}:${h}:${theme}:${kinds}:${from}`, () => {
        const s = sky(w, h, theme, 41);
        let x = from;
        kinds.forEach((k, i) => {
          const size = sizeOf(k, i);
          s.blit(planet(k, size, hashStr(k) % 997), x, Math.round((h - size) / 2) + (i % 2 ? -3 : 2));
          x += size + 12;
        });
        return s.url();
      });
    },
    // tiny repeating background tile (8x8) for the page
    pattern: (theme) => memo(`pattern:${theme}`, () => {
      const p = new Px(16, 16);
      const base = theme === 'dark' ? '#1d1838' : '#fff1d6', dot = theme === 'dark' ? '#2a2350' : '#ffe2ad';
      p.rect(0, 0, 16, 16, base);
      p.set(3, 3, dot); p.set(11, 11, dot); p.set(4, 3, dot); p.set(12, 11, dot);
      return p.url();
    }),
  };
  root.Pixel = api;
})(window);

// color.js — цветовая математика: разбор цветов, OKLCH, контраст WCAG 2, правила перекраски.
// Цвет — массив [r, g, b, a] с каналами 0..1. Светлота меняется в OKLCH — перцептивно равномерном
// пространстве (CSS Color 4), поэтому оттенок и насыщенность сохраняются.
//
// Основные функции:
//   parseColor(css)                          строка CSS → [r, g, b, a] (с кэшем)
//   toOklch(rgba), fromOklch(lch)            sRGB ↔ OKLCH
//   luminance(rgba), contrast(a, b)          яркость и контраст по WCAG 2
//   mapSurface(rgba, palette)                светлый фон → тёмная поверхность палитры
//   mapForeground(rgba, bg, min, palette)    текст и графика → цвет с контрастом не ниже min
//   mapBorder, mapGradient, mapShadow        рамки, градиенты, тени

'use strict';

const colorCanvas = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
const parsedColors = new Map();
const RGB = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/;

// Вычисленные стили почти всегда rgb()/rgba(); любой другой синтаксис разбирает браузер через холст 1×1.
const parseColor = (css) => {
  let color = parsedColors.get(css);
  if (color) return color;
  const match = RGB.exec(css);
  if (match) {
    color = [match[1] / 255, match[2] / 255, match[3] / 255, match[4] === undefined ? 1 : Number(match[4])];
  } else {
    colorCanvas.clearRect(0, 0, 1, 1);
    colorCanvas.fillStyle = '#0000'; // Недопустимая строка оставила бы прежний fillStyle.
    colorCanvas.fillStyle = css;
    colorCanvas.fillRect(0, 0, 1, 1);
    color = [...colorCanvas.getImageData(0, 0, 1, 1).data].map((v) => v / 255);
  }
  parsedColors.set(css, color);
  return color;
};

const toHex = ([r, g, b, a]) =>
  `#${[r, g, b, ...(a < 1 ? [a] : [])].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// Относительная яркость и коэффициент контраста WCAG 2.
const luminance = ([r, g, b]) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Полупрозрачный цвет так, как он виден поверх непрозрачного фона.
const blend = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];

// sRGB <-> OKLCH, матрицы Бьёрна Оттоссона (https://bottosson.github.io/posts/oklab/).
const toOklch = ([r, g, b, a]) => {
  [r, g, b] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), Math.atan2(B, A), a];
};

const fromOklch = ([L, C, h, a]) => {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  // ponytail: обрезка по каналам вместо отображения в охват sRGB; насыщенность достаточно мала, разницы не видно.
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((c) => Math.min(1, Math.max(0, toGamma(Math.max(0, c)))))
    .concat(a);
};

const isNeutral = ([, C]) => C < 0.08;

// Светлота OKLCH, ниже которой цветной текст воспринимается как почти чёрный (замер: тёмно-синий
// #081449 — 0,225; ссылка Google #1a0dab — 0,351; тёмно-бордовый #5a0000 — 0,294).
const NEAR_BLACK = 0.27;

// Палитра: цвета поверхности и текста тёмной темы, заранее переведённые в OKLCH.
const createPalette = ({ surface, text }) => ({
  surface: toOklch(parseColor(surface)),
  text: toOklch(parseColor(text)),
});

// Светлые малонасыщенные поверхности становятся тёмными. Чем темнее оригинал, тем светлее результат —
// порядок высот Material Design сохраняется: приподнятые карточки светлее страницы. Насыщенные
// фирменные и уже тёмные цвета не меняются. Возвращает null, если цвет остаётся прежним.
const mapSurface = (rgba, palette) => {
  const lch = toOklch(rgba);
  const [L, C, h, a] = lch;
  if (a === 0) return null;
  if (L > 0.6 && isNeutral(lch)) {
    const [baseL, baseC, baseH] = palette.surface;
    const mappedL = Math.min(baseL + (1 - L) * 0.8, 0.5);
    // Серые получают оттенок палитры; пастельные сохраняют свой оттенок.
    return fromOklch(C < 0.02 ? [mappedL, baseC, baseH, a] : [mappedL, C * 0.6, h, a]);
  }
  // Слабые тёмные наложения (подсветка при наведении, разделители) становятся слабыми светлыми.
  if (a <= 0.2 && L < 0.4 && isNeutral(lch)) return fromOklch([1 - L, C, h, a]);
  return null;
};

// Передний план (текст, иконки, рамки) меняется, только если его контраст с фактическим фоном ниже
// `min` (WCAG 2: 4,5 для текста, 3 для графики). Нейтральные цвета инвертируют светлоту в диапазоне
// цвета текста палитры, поэтому второстепенный текст остаётся тусклее основного.
const mapForeground = (rgba, background, min, palette) => {
  if (rgba[3] === 0 || contrast(blend(rgba, background), background) >= min) return null;
  let [L, C, h, a] = toOklch(rgba);
  const lighten = luminance(background) < 0.18;
  if (lighten) {
    // Почти чёрный цветной текст (L < NEAR_BLACK: тёмно-синий основной текст тем ABP Lepton на
    // exam.nostroy) на светлом фоне читается как чёрный — он становится обычным текстом палитры, а не
    // светло-голубым. Ссылки и фирменные цвета светлее порога и сохраняют оттенок.
    if (C < 0.02 || L < NEAR_BLACK) [L, C, h] = [palette.text[0] - L * 0.4, palette.text[1], palette.text[2]];
    else [L, C] = [isNeutral([L, C]) ? palette.text[0] - L * 0.4 : Math.max(1 - L * 0.5, 0.7), Math.min(C, 0.16)];
  }
  const step = lighten ? 0.02 : -0.02;
  let rgb = fromOklch([L, C, h, a]);
  while (contrast(blend(rgb, background), background) < min && L > 0 && L < 1) {
    L += step;
    rgb = fromOklch([L, C, h, a]);
  }
  // Полупрозрачному цвету может не хватить одной светлоты (белый на 40 % поверх тёмного — около
  // 3,6 : 1, подсказки полей ввода): тогда повышается непрозрачность.
  while (contrast(blend(rgb, background), background) < min && a < 1) {
    a = Math.min(1, a + 0.1);
    rgb = fromOklch([L, C, h, a]);
  }
  return rgb;
};

// Светлые нейтральные рамки становятся на ступень светлее разделяемых поверхностей; остальные
// подчиняются правилу контраста графики (3 : 1) с фоном вокруг элемента.
const mapBorder = (rgba, background, palette) => {
  if (rgba[3] === 0) return null;
  const lch = toOklch(rgba);
  if (lch[0] > 0.6 && isNeutral(lch)) {
    const [L, C, h, a] = toOklch(mapSurface(rgba, palette));
    return fromOklch([L + 0.1, C, h, a]);
  }
  return background && mapForeground(rgba, background, 3, palette);
};

const COLOR_TOKEN = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)|#[\da-f]{3,8}\b/gi;

// Пересчитывает каждый цвет внутри составного значения (градиент, тень). null — ничего не изменилось.
const mapTokens = (css, map) => {
  let changed = false;
  const mapped = css.replace(COLOR_TOKEN, (token) => {
    const color = map(parseColor(token));
    if (!color) return token;
    changed = true;
    return toHex(color);
  });
  return changed ? mapped : null;
};

// Градиенты: каждая опорная точка пересчитывается как поверхность.
const mapGradient = (css, palette) => mapTokens(css, (rgba) => mapSurface(rgba, palette));

// Тени: затемняются только светлые (свечение, белые обводки); тёмные тени и так подходят тёмной странице.
const mapShadow = (css, palette) =>
  mapTokens(css, (rgba) => {
    const lch = toOklch(rgba);
    return lch[0] > 0.6 && isNeutral(lch) ? mapSurface(rgba, palette) : null;
  });

const firstColor = (css) => {
  const token = css.match(COLOR_TOKEN)?.[0];
  return token ? parseColor(token) : null;
};

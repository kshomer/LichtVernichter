// engine.js — движок тёмной темы. Читает вычисленные цвета каждого элемента, пересчитывает их
// (color.js) и применяет атрибутами data-lv-*, которым соответствуют правила одной таблицы стилей
// расширения. Таблицы стилей и inline-стили сайта не изменяются.
//
// Правило минимального вмешательства: светлые нейтральные поверхности затемняются; текст, рамки и
// иконки меняются только там, где затемнён фон под ними. Фирменные цвета и цветовые пары сайта
// сохраняются.
//
// Внешний интерфейс:
//   Engine.start(colors)   включить тему на странице
//   Engine.stop()          выключить и снять все переопределения
//
// Основные функции внутри:
//   analyze(el, writes)    фаза чтения: переопределения одного элемента
//   processChunk(els)      пакет: снять старое, прочитать, записать
//   flush()                кадровый колбэк: задания в пределах бюджета кадра
//   onMutations(records)   новые узлы и смена атрибутов (MutationObserver)
//   onStateChange()        :hover и :focus — перечитывание до отрисовки
//   restyle()              поздние таблицы стилей: адресное перечитывание

'use strict';

const Engine = (() => {
  // Атрибут -> переопределяемое свойство. Атрибуты с before/after относятся к ::before / ::after.
  const PROPS = {
    'data-lv-bg': 'background-color',
    'data-lv-fg': 'color',
    'data-lv-tfc': '-webkit-text-fill-color',
    'data-lv-bgi': 'background-image',
    'data-lv-shadow': 'box-shadow',
    'data-lv-outline': 'outline-color',
    'data-lv-bt': 'border-top-color',
    'data-lv-br': 'border-right-color',
    'data-lv-bb': 'border-bottom-color',
    'data-lv-bl': 'border-left-color',
    'data-lv-fill': 'fill',
    'data-lv-stroke': 'stroke',
    'data-lv-blend': 'mix-blend-mode',
    'data-lv-before-bg': 'background-color',
    'data-lv-before-fg': 'color',
    'data-lv-before-bgi': 'background-image',
    'data-lv-after-bg': 'background-color',
    'data-lv-after-fg': 'color',
    'data-lv-after-bgi': 'background-image',
    'data-lv-placeholder-fg': 'color',
  };
  // Поднимает вес селектора атрибута до уровня ID (3,1,0), не меняя того, что он выбирает: иначе
  // правила сайта вроде `a.dark_link { color: … !important }` (0,1,1) сильнее наших.
  // Недосягаемы для любой таблицы стилей только inline-стили с `!important`.
  const BOOST = ':not(#--lv):not(#--lv):not(#--lv)';
  const ATTRS = [...Object.keys(PROPS), 'data-lv-invert'];
  const ACTIVE = 'data-lv-active';
  const BUSY = 'data-lv-busy';
  const ALL_ATTRS_SELECTOR = [...ATTRS, BUSY].map((attr) => `[${attr}]`).join();
  const SIDES = [
    ['data-lv-bt', 'borderTop'],
    ['data-lv-br', 'borderRight'],
    ['data-lv-bb', 'borderBottom'],
    ['data-lv-bl', 'borderLeft'],
  ];
  // Элементы без собственных цветов (или со своим документом внутри): не обрабатываются.
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED']);
  // Атрибуты, которые отслеживаются всегда; к ним добавляются атрибуты из селекторов сайта.
  const BASE_ATTRIBUTES = ['class', 'style', 'src', 'media', 'disabled'];
  const OBSERVE = {
    childList: true,
    subtree: true,
    characterData: true, // Правка текста внутри <style>.
    attributes: true,
    attributeOldValue: true, // Позволяет пропускать перезапись class и style тем же значением.
    attributeFilter: BASE_ATTRIBUTES,
  };
  // Опрос правил, добавленных через CSSOM: каждые 0,5 с, пока стили меняются, с замедлением до 4 с
  // на спокойной странице. CSS-in-JS обычно добавляет правила прямо перед отрисовкой новых узлов,
  // а их движок и так читает уже с новыми правилами; опрос ловит остальное.
  const STYLE_POLL_MIN_MS = 500;
  const STYLE_POLL_MAX_MS = 4000;
  const STYLE_SETTLE_MS = 50; // Серия вставок <style> объединяется в одну проверку.
  const FRAME_BUDGET_MS = 8; // Половина кадра 60 Гц на перечитывание уже оформленных элементов.
  const CHUNK = 64;
  const VIEWPORT_FIRST_MIN = 500; // Маленькие задания дешевле выполнить целиком, чем сортировать.
  const SYNC_MAX = 300; // Изменения до стольких элементов оформляются сразу, до отрисовки…
  const SYNC_BUDGET_MS = 4; // …пока такая работа укладывается в это время за кадр.
  const MAX_TARGETED = 1000;
  // Псевдоэлементы недопустимы в querySelectorAll; важен элемент, которому они принадлежат.
  const PSEUDO_ELEMENT = /::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)/gi;
  const MAX_STATE_SUBTREE = 500;
  const MAX_CACHE = 5000;
  // Замещаемые элементы и фигуры SVG не отрисовывают ::before / ::after: читать их — лишняя работа.
  const NO_PSEUDO = new Set(['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
  // Поля ввода: только у них сайты задают -webkit-text-fill-color для автозаполнения. Чтение этого
  // свойства у всех элементов стоило бы ~8 % JavaScript движка.
  const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  // Режимы наложения, которые только затемняют: результат не светлее фона под элементом. Сайты так
  // «растворяют» белый фон фотографий товаров в светлой карточке; на затемнённой карточке фото
  // почти целиком становится тёмным (Аскона). Такое наложение сбрасывается в normal — фото видно
  // как есть, со своим фоном, как любая фотография на белом.
  const DARKENING_BLEND = new Set(['multiply', 'darken', 'color-burn']);
  const resetBlend = (el, style, surface, writes) => {
    if (DARKENING_BLEND.has(style.mixBlendMode) && darkened(surface)) writes.push([el, 'data-lv-blend', 'normal']);
  };
  // Длительность перехода не нулевая: в значении есть цифра, кроме нуля («0s» — нет перехода).
  const MOVING = /[1-9]/;
  const WHITE = [1, 1, 1, 1];
  const IMAGE = { orig: null, now: null }; // Поверхность поверх картинки: её цвета неизвестны.

  // Поля ввода получают тёмную отрисовку браузера, полосы прокрутки — цвета палитры. Переходы CSS
  // у перечитываемого элемента выключены: иначе снятие переопределения анимировалось бы к исходному
  // цвету. Флаг ставится только на элементы с переходами и без `*`: правило с потомками заставляло бы
  // браузер пересчитывать стили всего поддерева при установке и снятии флага. Флагу нужен тот же вес
  // BOOST, что и цветам: иначе `transition: … !important` сайта с более длинным селектором (Taiga UI
  // у автозаполненных полей) побеждает, переход не отключается, и сайт, слушающий transitionstart,
  // отвечает сменой класса — бесконечный круг перечитываний (мигание подписи поля).
  const baseRules = ({ surface, scrollbar }) => `
    :root[${ACTIVE}] { scrollbar-color: ${scrollbar} ${surface} !important; }
    :is(input, textarea, select) { color-scheme: dark; }
    [data-lv-invert]${BOOST} { filter: invert(0.9) hue-rotate(180deg) !important; }
    [${BUSY}]${BOOST}, [${BUSY}]${BOOST}::before, [${BUSY}]${BOOST}::after { transition: none !important; }`;

  const sheet = new CSSStyleSheet();
  const rules = new Set();
  const roots = new Set();
  const queue = new Set();
  const iconChecks = new Map();
  const icons = new WeakMap(); // элемент -> ключ последней проверки иконки
  const compounds = new Map(); // Длинные значения (градиенты, тени) обозначаются короткими номерами.
  // Результат пересчёта зависит только от входных данных. parseColor и этот кэш возвращают одни и те
  // же массивы для равных цветов, поэтому hex-строки кэшируются по массиву, а ключи остаются короткими.
  let mappings = new Map();
  const hexes = new WeakMap();
  let surfaces = new WeakMap(); // элемент -> { orig, now }: фон под содержимым до и после
  let paints = new WeakMap(); // элемент -> { color, fill, stroke }: hex-значения { read, final }
  let moving = new WeakSet(); // элементы с переходами CSS (у себя или у ::before / ::after)
  let palette = null;
  let canvas = null;
  let observer = null;
  let frame = 0;
  let syncSpent = 0; // Время мгновенной обработки с последнего кадрового колбэка.
  let styleTimer = 0;
  let pollDelay = STYLE_POLL_MIN_MS;
  let styleCheck = 0;
  let styleSignature = '';
  let stylesChanged = false;
  let knownRules = new Map(); // CSSStyleRule -> selectorText читаемых таблиц страницы
  let knownOpaque = new Set(); // Таблицы с других доменов, правила которых прочитать нельзя
  // href -> правила, разобранные из текста, загруженного service worker'ом; null — грузится, false — не удалось.
  const opaqueRules = new Map();
  let index = null; // Классы и атрибуты из селекторов (см. buildIndex)
  let pseudoOwners = null; // Селектор элементов, у которых могут быть ::before/::after; null — неизвестно
  const jobs = []; // { starts, elements, next, urgent }: работа, оставшаяся с прошлых кадров
  // Элементы под указателем и в фокусе: :hover и :focus-within действуют на всю цепочку предков.
  const chains = { hover: [], focus: [] };

  const hexOf = (rgba) => {
    let hex = hexes.get(rgba);
    if (!hex) hexes.set(rgba, (hex = toHex(rgba)));
    return hex;
  };

  const cached = (key, compute) => {
    if (mappings.has(key)) return mappings.get(key);
    if (mappings.size > MAX_CACHE) mappings = new Map();
    const value = compute();
    mappings.set(key, value);
    return value;
  };

  const surfaceFor = (css) => cached(`s${css}`, () => mapSurface(parseColor(css), palette));
  const gradientFor = (css) => cached(`g${css}`, () => mapGradient(css, palette));

  const parentOf = (el) => el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
  const darkened = (surface) => surface.now !== surface.orig;
  const small = (el) => el.getElementsByTagName('*').length <= MAX_STATE_SUBTREE;

  const surfaceOf = (el) => {
    for (; el; el = parentOf(el)) if (surfaces.has(el)) return surfaces.get(el);
    return canvas;
  };

  const adopt = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    observer.observe(root, OBSERVE);
  };

  // Элементы поддерева в порядке документа, включая открытые shadow root.
  const collect = (start, out) => {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT, (node) =>
      SKIP.has(node.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    );
    for (let el = start.nodeType === Node.ELEMENT_NODE ? start : walker.nextNode(); el; el = walker.nextNode()) {
      out.push(el);
      if (el.shadowRoot) {
        adopt(el.shadowRoot);
        collect(el.shadowRoot, out);
      }
    }
  };

  // Тёмные монохромные иконки на затемнённой поверхности инвертируются. Изображение анализирует
  // service worker (на него не действует CORS) и возвращает только ответ «да/нет».
  // `crop` выбирает видимую часть CSS-фона (спрайты); null — изображение целиком.
  const checkIcon = (el, url, surface, crop = null) => {
    if (!url || !darkened(surface) || /\.jpe?g(?:[?#]|$)/i.test(url)) return; // В JPEG нет прозрачности.
    const { width, height } = el.getBoundingClientRect();
    if (!width || width > 512 || height > 256) return;
    if (crop) Object.assign(crop, { width, height });
    const key = JSON.stringify([url, crop]);
    let check = iconChecks.get(key);
    if (!check) {
      check = ask({ type: 'icon', url, crop }).catch(() => false);
      iconChecks.set(key, check);
    }
    icons.set(el, key);
    // Ответ устарел, если элемент с тех пор перечитан (другая иконка или фон уже не затемнён).
    check.then((dark) => dark && palette && icons.get(el) === key && el.setAttribute('data-lv-invert', ''));
  };

  const compoundId = (css) => {
    if (!compounds.has(css)) compounds.set(css, String(compounds.size));
    return compounds.get(css);
  };

  // Делит вычисленное многослойное значение по запятым верхнего уровня (в data: URL бывают запятые).
  const layers = (css) => {
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '(') depth++;
      else if (css[i] === ')') depth--;
      else if (css[i] === ',' && depth === 0) {
        parts.push(css.slice(from, i).trim());
        from = i + 1;
      }
    }
    return [...parts, css.slice(from).trim()];
  };

  // Небольшая картинка без повтора (стрелка списка .form-select, лупа в поле поиска) лежит рядом с
  // текстом, а не под ним: фоном под текстом остаётся цвет элемента. Признак — у каждого слоя с
  // картинкой нет повтора и размер задан в пикселях не больше SMALL_ICON. Большие и неизвестные
  // размеры (cover, auto, проценты) — по-прежнему картинка под текстом.
  const SMALL_ICON = 64;
  const isDecoration = (style, image) => {
    const repeats = layers(style.backgroundRepeat);
    const sizes = layers(style.backgroundSize);
    return layers(image).every((layer, i) => {
      if (!layer.startsWith('url(')) return true;
      const size = (sizes[i] ?? sizes[0]).split(' ');
      return (repeats[i] ?? repeats[0]).includes('no-repeat') && size.every((v) => v.endsWith('px') && parseFloat(v) <= SMALL_ICON);
    });
  };

  // Иконка в CSS-фоне: первый слой с изображением, со своим положением и размером.
  const checkBackgroundIcon = (el, style, image, surface) => {
    const images = layers(image);
    const at = images.findIndex((layer) => layer.startsWith('url('));
    const url = /^url\("?(.*?)"?\)$/.exec(images[at])?.[1];
    const pick = (css) => layers(css)[at] ?? layers(css)[0];
    checkIcon(el, url, surface, { position: pick(style.backgroundPosition), size: pick(style.backgroundSize) });
  };

  // Спрайты и иконочные шрифты часто прячут подпись отступом, прозрачным цветом или нулевым размером.
  const hasVisibleText = (el, style) =>
    el.textContent.trim() !== '' &&
    parseColor(style.color)[3] > 0 &&
    parseFloat(style.fontSize) > 0 &&
    Math.abs(parseFloat(style.textIndent)) < 999;

  // Наследуемые цвета (color, fill, stroke). По вычисленному стилю не отличить унаследованное
  // значение от явно заданного, равного родительскому, поэтому учтены оба случая: изменённое
  // значение записывается всегда, а сохранённое закрепляется, если оно могло прийти от изменённого родителя.
  const resolvePaint = (el, state, parentState, prop, attr, css, wanted, writes) => {
    const read = hexOf(parseColor(css));
    const parent = parentState?.[prop];
    const inherited = parent && read === parent.read ? parent.final : read;
    const final = wanted ? hexOf(wanted) : read;
    if (final !== read || final !== inherited) writes.push([el, attr, final]);
    state[prop] = { read, final };
  };

  // Фаза чтения: расчёт переопределений одного элемента. Запись откладывается, чтобы не чередовать
  // чтения и записи (каждое такое чередование — повторный расчёт раскладки).
  const analyze = (el, writes) => {
    const style = getComputedStyle(el);
    const parent = parentOf(el);
    const parentSurface = surfaceOf(parent);
    const parentState = paints.get(parent);
    const state = {};
    paints.set(el, state);
    const set = (attr, rgba) => writes.push([el, attr, hexOf(rgba)]);
    const foreground = (css, surface, min) =>
      surface.now && darkened(surface)
        ? cached(`f${css}|${hexOf(surface.now)}|${min}`, () => mapForeground(parseColor(css), surface.now, min, palette))
        : null;
    let surface = parentSurface;
    let busy = MOVING.test(style.transitionDuration);
    // Переход цвета уже идёт, а флага нет: элемент получил переход вместе с новым классом или
    // состоянием (Ламода: класс при наведении приносит и белый фон, и `transition`), поэтому заранее
    // его не пометить. Вычисленные значения сейчас промежуточные — флаг отменяет переход, и чтения
    // ниже дают итоговые цвета (style — «живой» объект, он сам отражает новое состояние).
    if (busy && !el.hasAttribute(BUSY) && el.getAnimations().some(isColorTransition)) el.setAttribute(BUSY, '');

    if (style.maskImage !== 'none') {
      // Иконка-маска рисует форму цветом фона: это передний план, а не поверхность.
      const icon = foreground(style.backgroundColor, parentSurface, 3);
      if (icon) set('data-lv-bg', icon);
    } else {
      // Прозрачный корень показывает холст браузера — белый на светлых страницах.
      const transparentRoot = el === document.documentElement && parseColor(style.backgroundColor)[3] === 0;
      const ownCss = transparentRoot ? 'rgb(255, 255, 255)' : style.backgroundColor;
      const own = parseColor(ownCss);
      const mapped = surfaceFor(ownCss);
      if (mapped) set('data-lv-bg', mapped);
      if (own[3] > 0.9) surface = { orig: own, now: mapped ?? own };

      const image = style.backgroundImage;
      if (image.includes('url(')) {
        if (!isDecoration(style, image)) surface = IMAGE; // Текст поверх картинки сохраняет исходный цвет.
        resetBlend(el, style, parentSurface, writes);
        if (!el.childElementCount && !hasVisibleText(el, style)) checkBackgroundIcon(el, style, image, parentSurface);
      } else if (image !== 'none') {
        const gradient = gradientFor(image);
        if (gradient) writes.push([el, 'data-lv-bgi', compoundId(gradient), gradient]);
        const first = firstColor(image);
        if (first?.[3] > 0.9) surface = gradient ? { orig: first, now: firstColor(gradient) } : { orig: first, now: first };
      }
    }
    surfaces.set(el, surface);

    resolvePaint(el, state, parentState, 'color', 'data-lv-fg', style.color, foreground(style.color, surface, 4.5), writes);
    // -webkit-text-fill-color рисует текст поверх color. Обычно оно равно currentcolor и следует за
    // color (тогда значения совпадают); заданное явно — например, правилами сайта для полей с
    // автозаполнением — пересчитывается по тому же правилу контраста, иначе тёмный текст остался бы
    // на затемнённом поле (ikus.pesc.ru).
    if (FIELDS.has(el.tagName) && style.webkitTextFillColor !== style.color) {
      const textFill = foreground(style.webkitTextFillColor, surface, 4.5);
      if (textFill) set('data-lv-tfc', textFill);
    }
    // Подсказка пустого поля — отдельный псевдоэлемент ::placeholder: сайты задают ей свой цвет (Озон —
    // тёмно-синий на 40 %), который не наследует пересчитанный color поля. Читается только у полей
    // с подсказкой — одно чтение стиля на поле.
    if (el.placeholder) {
      const hint = foreground(getComputedStyle(el, '::placeholder').color, surface, 4.5);
      if (hint) set('data-lv-placeholder-fg', hint);
    }

    // Рамка лежит между элементом и родителем: учитывается тот из двух фонов, что затемнён.
    const around = darkened(parentSurface) ? parentSurface.now : darkened(surface) ? surface.now : null;
    if (around) {
      const border = (css) => cached(`b${css}|${hexOf(around)}`, () => mapBorder(parseColor(css), around, palette));
      // Вычисленная толщина рамки равна 0px на каждой стороне со стилем none: одно чтение вместо четырёх.
      if (style.borderWidth !== '0px') {
        for (const [attr, side] of SIDES) {
          if (style[`${side}Style`] === 'none' || !parseFloat(style[`${side}Width`])) continue;
          const color = border(style[`${side}Color`]);
          if (color) set(attr, color);
        }
      }
      if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth)) {
        const outline = border(style.outlineColor);
        if (outline) set('data-lv-outline', outline);
      }
      const shadow = style.boxShadow !== 'none' && cached(`h${style.boxShadow}`, () => mapShadow(style.boxShadow, palette));
      if (shadow) writes.push([el, 'data-lv-shadow', compoundId(shadow), shadow]);
    }

    if (el instanceof SVGElement) {
      for (const prop of ['fill', 'stroke']) {
        const paint = style[prop];
        if (paint === 'none' || paint.startsWith('url(')) continue;
        resolvePaint(el, state, parentState, prop, `data-lv-${prop}`, paint, foreground(paint, surface, 3), writes);
      }
    } else {
      if (el.tagName === 'IMG') {
        checkIcon(el, el.currentSrc || el.src, surface);
        resetBlend(el, style, surface, writes);
      }
      // У содержимого SVG и замещаемых элементов нет ::before / ::after.
      if (!NO_PSEUDO.has(el.tagName) && mayHavePseudo(el)) {
        for (const pseudo of ['before', 'after']) {
          const pseudoStyle = getComputedStyle(el, `::${pseudo}`);
          if (pseudoStyle.content === 'none' || pseudoStyle.content === 'normal') continue;
          busy ||= MOVING.test(pseudoStyle.transitionDuration);
          const own = parseColor(pseudoStyle.backgroundColor);
          const mapped = surfaceFor(pseudoStyle.backgroundColor);
          if (mapped) set(`data-lv-${pseudo}-bg`, mapped);
          const pseudoImage = pseudoStyle.backgroundImage;
          const gradient = pseudoImage.includes('gradient(') && !pseudoImage.includes('url(') && gradientFor(pseudoImage);
          if (gradient) writes.push([el, `data-lv-${pseudo}-bgi`, compoundId(gradient), gradient]);
          const under = own[3] > 0.9 ? { orig: own, now: mapped ?? own } : surface;
          const text = foreground(pseudoStyle.color, under, 4.5);
          resolvePaint(el, {}, state, 'color', `data-lv-${pseudo}-fg`, pseudoStyle.color, text, writes);
        }
      }
    }

    // Флаг пишется вместе с новыми цветами: браузер применяет их одним пересчётом стилей, уже без
    // перехода. Запоминание нужно при перечитывании: тогда флаг ставится до снятия старых цветов
    // (см. processChunk).
    if (busy) {
      moving.add(el);
      writes.push([el, BUSY, '']);
    }
  };

  const write = ([el, attr, value, cssValue = value]) => {
    const key = `${attr}=${value}`;
    if (attr !== BUSY && !rules.has(key)) {
      rules.add(key);
      // data-lv-before-… / -after-… / -placeholder-… относятся к псевдоэлементу с тем же именем.
      const pseudo = /-(before|after|placeholder)-/.exec(attr)?.[1];
      sheet.insertRule(`[${attr}="${value}"]${BOOST}${pseudo ? `::${pseudo}` : ''} { ${PROPS[attr]}: ${cssValue} !important; }`, sheet.cssRules.length);
    }
    el.setAttribute(attr, value);
  };

  // Снимает флаг через два кадра, когда итоговые цвета хотя бы раз отрисованы: если снять раньше,
  // переход мог бы начаться от цвета, прочитанного без переопределений. Снимает только свой флаг:
  // если элемент с тех пор обработан снова (указатель ушёл со строки и вернулся за кадр), флаг
  // принадлежит новой обработке. Иначе устаревшее снятие открывало переход сайта от светлого цвета
  // состояния к нашему — а идущий переход сильнее !important (строки таблиц exam.nostroy).
  const settling = new WeakMap(); // элемент -> метка последнего запланированного снятия
  const settle = (elements) => {
    const mark = {};
    for (const el of elements) settling.set(el, mark);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const el of elements) if (settling.get(el) === mark) el.removeAttribute(BUSY);
      }),
    );
  };

  // Превращает очередь в задание: поддеревья в порядке документа.
  const takeQueue = () => {
    // Поддеревья, чей предок тоже в очереди, покрываются этим предком.
    const starts = [...queue].filter((node) => {
      if (SKIP.has(node.tagName)) return false;
      for (let p = parentOf(node); p; p = parentOf(p)) if (queue.has(p)) return false;
      return node.isConnected;
    });
    queue.clear();
    if (!starts.length) return null;
    const elements = [];
    for (const start of starts) collect(start, elements);
    return prioritize({ starts, elements, next: 0, urgent: elements.length });
  };

  // Задания с большим количеством нового содержимого начинают с того, что видно: элементы в пределах
  // экрана от окна, элементы нулевого размера (скрытые меню, обёртки) и все их предки — родитель
  // всегда обрабатывается раньше детей. Остальное подождёт следующих кадров. Уже оформленные
  // элементы не измеряются: их можно отложить в любом случае, если они не предки срочных.
  const byViewport = (elements) => {
    const margin = innerHeight;
    const urgent = new Set();
    for (const el of elements) {
      if (urgent.has(el) || paints.has(el)) continue;
      const { top, bottom, width, height } = el.getBoundingClientRect();
      if (width && height && (bottom < -margin || top > innerHeight + margin)) continue;
      for (let node = el; node && !urgent.has(node); node = parentOf(node)) urgent.add(node);
    }
    const first = elements.filter((el) => urgent.has(el));
    return [first, elements.filter((el) => !urgent.has(el))];
  };

  // Перечитывание оформленных элементов не сортируется: их и так можно отложить, а измерение тысяч
  // положений стоило бы отдельного кадра.
  const prioritize = (job) => {
    const fresh = job.elements.reduce((count, el) => count + !paints.has(el), 0);
    if (fresh < VIEWPORT_FIRST_MIN) return job;
    const [first, rest] = byViewport(job.elements);
    return { ...job, elements: [...first, ...rest], urgent: first.length };
  };

  // Прокрутка, пока новое содержимое ещё ждёт, пересортировывает ожидающую часть вокруг нового
  // положения окна. Событие scroll срабатывает до кадровых колбэков, поэтому показавшаяся часть
  // оформляется в том же кадре, а не остаётся светлой несколько кадров.
  let rescheduled = false;
  const onScroll = () => {
    if (rescheduled || !jobs.some((job) => job.next < job.elements.length && job.urgent < job.elements.length)) return;
    rescheduled = true;
    requestAnimationFrame(() => (rescheduled = false));
    for (const job of jobs) {
      const waiting = job.elements.slice(Math.max(job.next, job.urgent));
      if (!waiting.length) continue;
      const done = job.elements.slice(0, Math.max(job.next, job.urgent));
      const [first, rest] = byViewport(waiting);
      job.elements = [...done, ...first, ...rest];
      job.urgent = done.length + first.length;
    }
  };

  // Один пакет в три фазы: снять старые переопределения, всё прочитать, всё записать.
  // Известным элементам с переходами флаг ставится до снятия: иначе снятие запустило бы переход, а
  // getComputedStyle вернул бы его текущее, промежуточное значение вместо итогового (кнопка
  // Википедии оставалась белой). Флаг ставится здесь, а не при создании задания: снятие флага от
  // прошлого задания (settle) может прийти раньше, чем очередь дойдёт до элемента.
  const processChunk = (elements) => {
    for (const el of elements) {
      if (moving.has(el)) el.setAttribute(BUSY, '');
      for (const attr of ATTRS) el.removeAttribute(attr);
      icons.delete(el);
    }
    const writes = [];
    for (const el of elements) if (el.isConnected) analyze(el, writes);
    for (const entry of writes) write(entry);
    // После записи итоговые значения — то, что унаследуют дети при следующем перечитывании.
    for (const el of elements) for (const paint of Object.values(paints.get(el) ?? {})) paint.read = paint.final;
    const busy = elements.filter((el) => el.hasAttribute(BUSY));
    if (busy.length) settle(busy);
  };

  // Работает над заданием до конца (true) или до истечения срока. На потом остаются только элементы,
  // уже оформленные прошлым проходом, или лежащие вне окна: видимое не показывается неоформленным.
  const work = (job, deadline) => {
    while (job.next < job.elements.length) {
      const deferrable = job.next >= job.urgent || paints.has(job.elements[job.next]);
      if (performance.now() > deadline && deferrable) return false;
      const chunk = job.elements.slice(job.next, job.next + CHUNK);
      job.next += chunk.length;
      processChunk(chunk);
    }
    return true;
  };

  // Кадровый колбэк: новая работа встаёт в очередь, затем задания выполняются в пределах бюджета
  // кадра; остальное — в следующем кадре, так что долгое перечитывание не блокирует страницу больше
  // чем на ~8 мс за кадр.
  const flush = () => {
    frame = 0;
    syncSpent = 0;
    // Таблицы стилей появились, но ещё не просканированы (сканирование — в отдельной задаче): до тех
    // пор индексы неизвестны, поэтому читаются все псевдоэлементы и обрабатываются все смены классов.
    if (stylesChanged) {
      index.complete = false;
      pseudoOwners = null;
    }
    const job = takeQueue();
    if (job) jobs.push(job);
    // Сначала маленькие задания: открытие меню сменой класса не ждёт долгого перечитывания.
    jobs.sort((a, b) => a.elements.length - a.next - (b.elements.length - b.next));
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (jobs.length && work(jobs[0], deadline)) jobs.shift();
    if (jobs.length) frame = requestAnimationFrame(flush);
  };

  // :hover и :focus меняют вычисленные цвета без изменения DOM, MutationObserver их не видит (строка
  // становится светло-серой под указателем). Элементы со сменившимся состоянием перечитываются прямо
  // в обработчике события, до следующей отрисовки. Большие контейнеры пропускаются: вход указателя в
  // окно меняет состояние html и body, которые на практике не перекрашиваются при наведении.
  const onStateChange = (kind, target) => {
    if (!palette) return;
    const before = new Set(chains[kind]);
    const after = new Set();
    for (let el = target; el; el = parentOf(el)) after.add(el);
    chains[kind] = [...after];
    for (const el of new Set([...before, ...after])) {
      if (before.has(el) === after.has(el) || !el.isConnected) continue;
      if (small(el)) queue.add(el);
    }
    // Синхронно и без бюджета: цвета состояния должны быть на месте до следующей отрисовки.
    const job = takeQueue();
    if (job) work(job, Infinity);
  };

  // composedPath()[0] — самый внутренний элемент, в том числе внутри открытых shadow root.
  const LISTENERS = {
    pointerover: (event) => onStateChange('hover', event.composedPath()[0]),
    pointerout: (event) => event.relatedTarget || onStateChange('hover', null),
    focusin: (event) => onStateChange('focus', event.composedPath()[0]),
    focusout: (event) => event.relatedTarget || onStateChange('focus', null),
  };

  // Важны только настоящие таблицы стилей: preload, prefetch и иконки не несут CSS.
  const isStylesheet = (node) =>
    node?.nodeName === 'STYLE' || (node?.nodeName === 'LINK' && /\bstylesheet\b/i.test(node.rel));

  const scheduleStyleCheck = () => {
    styleCheck ||= setTimeout(() => {
      styleCheck = 0;
      checkStyles();
    }, STYLE_SETTLE_MS);
  };

  // Свойства, которые могут изменить пересчитываемые цвета: цвета, фоны, рамки, тени, заливка SVG,
  // фильтры, маски, генерируемое содержимое и пользовательские свойства (они могут питать любое из
  // них). Раскладка и видимость не важны: вычисленные цвета есть и у скрытых элементов.
  const COLOR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|filter|mask|content|^--|^all$/;

  // Запущенный переход CSS одного из цветовых свойств (переходы transform, opacity не мешают чтению цветов).
  const isColorTransition = (animation) => animation instanceof CSSTransition && COLOR_PROPERTY.test(animation.transitionProperty);

  const touchesColors = (declarations) => {
    for (let i = 0; i < declarations.length; i++) if (COLOR_PROPERTY.test(declarations[i])) return true;
    return false;
  };

  const tokens = (value) => new Set(value?.split(/\s+/).filter(Boolean));

  // Перезапись inline-стиля (блокировка прокрутки, transform слайдера, переменные окна…) важна, только
  // если добавлено, удалено или изменено цветовое объявление. Старое значение разбирает отдельный
  // блок объявлений, не связанный с документом.
  const declarations = document.createElement('div').style;
  const styleChangeMatters = (record) => {
    declarations.cssText = record.oldValue ?? '';
    const before = new Map([...declarations].map((name) => [name, declarations.getPropertyValue(name)]));
    const now = record.target.style;
    for (const name of new Set([...before.keys(), ...now])) {
      if (COLOR_PROPERTY.test(name) && before.get(name) !== now.getPropertyValue(name)) return true;
    }
    return false;
  };

  // Что изменилось, в обозначениях индекса: '[имя' атрибута, а для class ещё и '.класс' каждого
  // добавленного и удалённого класса. Перезапись тем же набором классов — пустой список.
  const changedTokens = ({ attributeName, oldValue, target }) => {
    if (attributeName !== 'class') return [`[${attributeName}`];
    const before = tokens(oldValue);
    const after = tokens(target.getAttribute('class'));
    const changed = [...before].filter((t) => !after.has(t)).concat([...after].filter((t) => !before.has(t)));
    return changed.length ? ['[class', ...changed.map((t) => `.${t}`)] : [];
  };

  // Класс, которого нет ни в одном селекторе цветовых правил, ничего не перекрашивает: фреймворки
  // часто переключают служебные классы (аналитика, флаги прокрутки). Остальные отслеживаемые атрибуты
  // важны всегда: они либо базовые, либо взяты из селекторов. Селекторы с `+`/`~` перекрашивают
  // следующих соседей элемента, с `:has(` — его предков (небольшие, как при наведении).
  const onAttribute = (record) => {
    const { attributeName, oldValue, target } = record;
    if (oldValue === target.getAttribute(attributeName)) return;
    if (attributeName === 'style') {
      if (!target.style || styleChangeMatters(record)) queue.add(target);
      return;
    }
    const changed = changedTokens(record);
    const used = (set) => changed.some((token) => set.has(token));
    if (attributeName === 'class' && (!changed.length || (index.complete && !used(index.tokens)))) return;
    queue.add(target);
    if (used(index.siblings)) for (let next = target.nextElementSibling; next; next = next.nextElementSibling) queue.add(next);
    if (used(index.ancestors)) for (let p = parentOf(target); p && small(p); p = parentOf(p)) queue.add(p);
  };

  const onMutations = (records) => {
    for (const record of records) {
      const { type, target } = record;
      if (isStylesheet(target) || isStylesheet(target.parentNode)) {
        stylesChanged = true; // Новый текст CSS, media или disabled у таблицы стилей.
      } else if (type === 'attributes') {
        onAttribute(record);
      } else if (type === 'childList') {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (isStylesheet(node)) stylesChanged = true;
          else if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) queue.add(node);
        }
      }
    }
    if (stylesChanged) scheduleStyleCheck();
    // Небольшие изменения после загрузки (подсказки, выпадающие списки, смена классов) оформляются в
    // этом колбэке: он выполняется сразу после кода сайта, поэтому новое содержимое оформлено до
    // отрисовки, даже если сайт создаёт его в своём кадровом колбэке, после нашего.
    // Большие пачки и разбор страницы идут через кадровый планировщик. Страницы, которые меняются
    // сериями (много мелких изменений в одной задаче), исчерпывают бюджет и переходят на
    // планировщик, а не растягивают задачу сайта.
    if (document.readyState !== 'loading' && syncSpent < SYNC_BUDGET_MS && queuedSize() <= SYNC_MAX) {
      const started = performance.now();
      const job = takeQueue();
      if (job) work(job, Infinity);
      syncSpent += performance.now() - started;
    }
    if (queue.size || syncSpent >= SYNC_BUDGET_MS) frame ||= requestAnimationFrame(flush);
  };

  const queuedSize = () => {
    let size = 0;
    for (const node of queue) if ((size += 1 + node.getElementsByTagName('*').length) > SYNC_MAX) break;
    return size;
  };

  // Число правил в таблицах страницы: дешёвая проверка, которая ловит правила, добавленные через
  // CSSOM (CSS-in-JS) без изменения DOM. Закрытые таблицы с других доменов читаются как '-'.
  const readStyleSignature = () =>
    [...document.styleSheets]
      .map((styleSheet) => {
        try {
          return styleSheet.cssRules.length;
        } catch {
          return '-';
        }
      })
      .join();

  // Учитываются только правила с цветовыми свойствами: новое правило с transform или opacity не
  // может изменить ни один пересчитываемый цвет и не требует перечитывания.
  const collectRules = (list, rules, visit) => {
    for (const rule of list) {
      if (rule.selectorText !== undefined && touchesColors(rule.style)) rules.set(rule, rule.selectorText);
      if (rule.cssRules) collectRules(rule.cssRules, rules, visit);
      if (rule.styleSheet) visit(rule.styleSheet);
    }
  };

  // Таблицы с других доменов один раз загружает service worker, текст разбирается в отдельную
  // таблицу, и их селекторы известны, как у любых других. Пока текст не пришёл (или если загрузить
  // его нельзя), таблица остаётся закрытой.
  const loadOpaque = (href) => {
    opaqueRules.set(href, null);
    ask({ type: 'stylesheet', url: href })
      .then((text) => {
        if (!text) throw new Error(`Таблица стилей недоступна: ${href}`);
        const parsed = new CSSStyleSheet();
        parsed.replaceSync(text); // replaceSync пропускает правила @import.
        const rules = new Map();
        collectRules(parsed.cssRules, rules, () => {});
        opaqueRules.set(href, rules);
        if (!palette) return;
        stylesChanged = true; // Её правила появятся как новые: адресное перечитывание.
        scheduleStyleCheck();
      })
      .catch(() => {
        opaqueRules.set(href, false);
        if (!palette) return;
        queue.add(document.documentElement); // Правила неизвестны: безопасно только полное перечитывание.
        frame ||= requestAnimationFrame(flush);
      });
  };

  // Правила, собранные по каждой таблице, переиспользуются, пока число её правил не изменилось:
  // чтение всех объявлений всех правил — самая дорогая часть сканирования.
  const sheetRules = new WeakMap();

  // Все правила стилей страницы (в том числе внутри @media, @supports, @layer, @import).
  // `opaque` — таблицы с других доменов, правила которых ещё неизвестны.
  const scanRules = () => {
    const rules = new Map();
    const opaque = new Set();
    const visit = (styleSheet) => {
      if (styleSheet.disabled) return;
      try {
        const list = styleSheet.cssRules;
        let cached = sheetRules.get(styleSheet);
        if (cached?.length !== list.length) {
          cached = { length: list.length, rules: new Map(), imports: [] };
          collectRules(list, cached.rules, (imported) => cached.imports.push(imported));
          sheetRules.set(styleSheet, cached);
        }
        for (const [rule, selector] of cached.rules) rules.set(rule, selector);
        for (const imported of cached.imports) visit(imported); // У таблиц @import свой кэш.
      } catch {
        const known = styleSheet.href && opaqueRules.get(styleSheet.href);
        if (known) for (const [rule, selector] of known) rules.set(rule, selector);
        else {
          opaque.add(styleSheet);
          if (styleSheet.href && !opaqueRules.has(styleSheet.href)) loadOpaque(styleSheet.href);
        }
      }
    };
    for (const styleSheet of document.styleSheets) visit(styleSheet);
    return { rules, opaque };
  };

  // Селектор элементов, которым принадлежат псевдоэлементы правила: `a::before` → `a`,
  // `.list ::after` → `.list *`. Часть списка из одного псевдоэлемента (`::selection`, `::before` в
  // `*, ::before, ::after`) отбрасывается: иначе осталась бы пустая часть и весь список стал бы недопустимым.
  const ownerSelector = (selector) =>
    layers(selector)
      .map((part) => part.replace(PSEUDO_ELEMENT, '').replace(/[\s>+~]$/, '$&*').trim())
      .filter(Boolean)
      .join();

  // Элементы, которые могут отрисовать ::before/::after: подходящие под правило, задающее
  // псевдоэлементу content (без content псевдоэлемента нет, и правила вроде `*, ::before, ::after
  // { border-color }` из Tailwind и Bootstrap не в счёт), и <q>, кавычки которого задаёт таблица
  // стилей браузера. Элементы в shadow root читаются всегда: их таблицы не сканируются.
  const PSEUDO_SELECTOR = /::?(?:before|after)\b/i;
  const buildPseudoOwners = (rules, opaque) => {
    if (opaque.size) return null;
    const owners = new Set(['q']);
    for (const [rule, selector] of rules) {
      if (!rule.style.content || !PSEUDO_SELECTOR.test(selector)) continue;
      const query = ownerSelector(selector);
      if (!query) continue;
      try {
        document.documentElement.matches(query); // Ошибка, если браузер не умеет такой селектор.
        owners.add(query);
      } catch {
        return null;
      }
    }
    return [...owners].join();
  };

  const mayHavePseudo = (el) => pseudoOwners === null || el.getRootNode() !== document || el.matches(pseudoOwners);

  // Классы ('.имя') и атрибуты ('[имя') из селекторов цветовых правил. complete = false, пока часть
  // таблиц не прочитана: тогда важна любая смена классов. siblings и ancestors — то же для селекторов
  // с `+`/`~` и с `:has(`. Разбор грубый (`+` в `:nth-child(2n+1)` тоже считается), но ошибается
  // только в сторону лишней работы.
  const TOKEN = /\.((?:\\.|[\w-])+)|\[\s*([\w-]+)/g;
  const buildIndex = (rules, opaque) => {
    const result = { complete: !opaque.size, tokens: new Set(), siblings: new Set(), ancestors: new Set() };
    for (const selector of rules.values()) {
      const sibling = /[+~]/.test(selector);
      const ancestor = selector.includes(':has(');
      for (const [, name, attribute] of selector.matchAll(TOKEN)) {
        const token = name ? `.${name.replace(/\\(.)/g, '$1')}` : `[${attribute.toLowerCase()}`;
        result.tokens.add(token);
        if (sibling) result.siblings.add(token);
        if (ancestor) result.ancestors.add(token);
      }
    }
    return result;
  };

  // Наблюдатель следит за базовыми атрибутами и за теми, что упомянуты в селекторах (aria-expanded,
  // data-state, open…): компоненты часто меняют цвета именно ими, а не классами.
  const observeAttributes = () => {
    const names = new Set(BASE_ATTRIBUTES);
    for (const token of index.tokens) if (token[0] === '[') names.add(token.slice(1));
    if ([...names].join() === OBSERVE.attributeFilter.join()) return;
    OBSERVE.attributeFilter = [...names];
    for (const root of roots) observer.observe(root, OBSERVE); // Повторный вызов заменяет параметры.
  };

  const updateIndexes = () => {
    index = buildIndex(knownRules, knownOpaque);
    pseudoOwners = buildPseudoOwners(knownRules, knownOpaque);
    observeAttributes();
  };

  // Элементы, подходящие под селекторы добавленных или удалённых правил, или null, когда безопасно
  // только полное перечитывание: неподдерживаемый селектор или слишком много совпадений.
  // Отдельный запрос на каждый селектор быстрее одного по объединённому списку: у одиночного
  // селектора есть быстрый путь Chrome (замер: 3 000 селекторов — 3 мс против 318 мс).
  const affectedBy = (selectors) => {
    const found = new Set();
    for (const selector of selectors) {
      const query = ownerSelector(selector);
      if (!query) continue; // ::selection, ::-webkit-scrollbar: цвета элементов не затронуты.
      try {
        for (const el of document.querySelectorAll(query)) found.add(el);
      } catch {
        return null;
      }
      if (found.size > MAX_TARGETED) return null;
    }
    return found;
  };

  // Сравнивает правила страницы с прошлым сканированием и перечитывает только то, что может затронуть
  // разница. Новую закрытую таблицу (с другого домена) изучить нельзя: тогда перечитывается весь документ.
  const restyle = () => {
    const { rules, opaque } = scanRules();
    const previousOpaque = knownOpaque;
    const opaqueChanged = opaque.size !== previousOpaque.size || [...opaque].some((s) => !previousOpaque.has(s));
    const selectors = new Set();
    for (const [rule, selector] of rules) if (!knownRules.has(rule)) selectors.add(selector);
    for (const [rule, selector] of knownRules) if (!rules.has(rule)) selectors.add(selector);
    knownRules = rules;
    knownOpaque = opaque;
    updateIndexes();
    // Новая таблица с другого домена ждёт своего текста (обработка — когда придут правила); таблица,
    // текст которой загрузить не удалось, не оставляет ничего для сравнения, поэтому её появление
    // или удаление означает полное перечитывание.
    const unreadable = [...opaque, ...previousOpaque].some((s) => opaqueRules.get(s.href) === false);
    const targets = opaqueChanged && unreadable ? null : affectedBy(selectors);
    if (targets) for (const el of targets) queue.add(el);
    else queue.add(document.documentElement);
    frame ||= requestAnimationFrame(flush);
  };

  // Возвращает, изменились ли таблицы стилей с прошлой проверки.
  const checkStyles = () => {
    if (document.hidden) return false;
    const signature = readStyleSignature();
    if (!stylesChanged && signature === styleSignature) return false;
    stylesChanged = false;
    styleSignature = signature;
    restyle();
    return true;
  };

  const poll = () => {
    pollDelay = checkStyles() ? STYLE_POLL_MIN_MS : Math.min(pollDelay * 2, STYLE_POLL_MAX_MS);
    styleTimer = setTimeout(poll, pollDelay);
  };

  // Таблица <link> применяется, когда загрузилась, а не когда вставлена.
  const onLoad = (event) => {
    if (!isStylesheet(event.target)) return;
    stylesChanged = true;
    scheduleStyleCheck();
  };

  const start = (colors) => {
    palette = createPalette(colors);
    mappings = new Map();
    canvas = { orig: WHITE, now: fromOklch(palette.surface) };
    sheet.replaceSync(baseRules(colors));
    rules.clear();
    observer ??= new MutationObserver(onMutations);
    styleSignature = readStyleSignature();
    ({ rules: knownRules, opaque: knownOpaque } = scanRules());
    adopt(document);
    updateIndexes();
    document.documentElement.setAttribute(ACTIVE, '');
    for (const [type, listener] of Object.entries(LISTENERS)) document.addEventListener(type, listener, true);
    document.addEventListener('load', onLoad, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    pollDelay = STYLE_POLL_MIN_MS;
    styleTimer = setTimeout(poll, pollDelay);
    queue.add(document.documentElement);
    frame ||= requestAnimationFrame(flush);
  };

  const stop = () => {
    palette = null;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    queue.clear();
    chains.hover = [];
    chains.focus = [];
    for (const [type, listener] of Object.entries(LISTENERS)) document.removeEventListener(type, listener, true);
    document.removeEventListener('load', onLoad, true);
    document.removeEventListener('scroll', onScroll, { capture: true });
    clearTimeout(styleTimer);
    clearTimeout(styleCheck);
    styleCheck = 0;
    stylesChanged = false;
    jobs.length = 0;
    knownRules = new Map();
    knownOpaque = new Set();
    index = null;
    pseudoOwners = null;
    OBSERVE.attributeFilter = BASE_ATTRIBUTES;
    surfaces = new WeakMap();
    paints = new WeakMap();
    moving = new WeakSet();
    document.documentElement.removeAttribute(ACTIVE);
    for (const root of roots) {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      for (const el of root.querySelectorAll(ALL_ATTRS_SELECTOR)) for (const attr of [...ATTRS, BUSY]) el.removeAttribute(attr);
    }
    roots.clear();
  };

  return { start, stop };
})();

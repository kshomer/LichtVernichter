// offscreen.js — offscreen-документ: единственный контекст расширения, умеющий растеризовать SVG
// (service worker не умеет). Решает, является ли иконка тёмной монохромной на прозрачном фоне.
//
// Основные функции:
//   isDarkIcon({ dataUrl, crop })   растеризация 24×24 и вердикт по пикселям
//   draw(image, crop, intrinsic)    видимая часть изображения или слоя CSS-фона (спрайта)
//   backgroundBox(image, crop)      положение и размер слоя фона по background-position/size

'use strict';

const SAMPLE = 24;
const canvas = Object.assign(document.createElement('canvas'), { width: SAMPLE, height: SAMPLE });
const context = canvas.getContext('2d', { willReadFrequently: true });

const length = (value, box, natural) =>
  value === 'auto' ? natural : value.endsWith('%') ? (box * parseFloat(value)) / 100 : parseFloat(value);

// У SVG без атрибута width нет собственного размера; браузер всё равно сообщает размер по умолчанию.
const hasIntrinsicSize = (dataUrl) =>
  !dataUrl.startsWith('data:image/svg') || /<svg[^>]*\swidth\s*=/i.test(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)));

// Прямоугольник слоя CSS-фона внутри элемента в CSS-пикселях: [x, y, ширина, высота].
// Изображения без собственного размера занимают размер элемента.
const backgroundBox = (image, crop, intrinsic) => {
  const naturalWidth = (intrinsic && image.naturalWidth) || crop.width;
  const naturalHeight = (intrinsic && image.naturalHeight) || crop.height;
  let width;
  let height;
  if (crop.size === 'contain' || crop.size === 'cover') {
    const scale = Math[crop.size === 'contain' ? 'min' : 'max'](crop.width / naturalWidth, crop.height / naturalHeight);
    [width, height] = [naturalWidth * scale, naturalHeight * scale];
  } else {
    const [w, h = 'auto'] = crop.size.split(' ');
    width = length(w, crop.width, naturalWidth);
    height = h !== 'auto' ? length(h, crop.height, naturalHeight) : w === 'auto' ? naturalHeight : (naturalHeight * width) / naturalWidth;
  }
  const [x, y = '50%'] = crop.position.split(' ');
  const offsetX = x.endsWith('%') ? ((crop.width - width) * parseFloat(x)) / 100 : parseFloat(x);
  const offsetY = y.endsWith('%') ? ((crop.height - height) * parseFloat(y)) / 100 : parseFloat(y);
  return [offsetX, offsetY, width, height];
};

// Рисует видимое в элементе на холст-образец. Рисование с размером назначения позволяет SVG
// масштабироваться по viewBox. `crop` описывает слой CSS-фона (спрайты); null — изображение целиком.
const draw = (image, crop, intrinsic) => {
  context.resetTransform();
  context.clearRect(0, 0, SAMPLE, SAMPLE);
  if (!crop) return context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  context.scale(SAMPLE / crop.width, SAMPLE / crop.height);
  context.drawImage(image, ...backgroundBox(image, crop, intrinsic));
};

const isDarkIcon = async ({ dataUrl, crop }) => {
  // `load`, а не image.decode(): decode() может не завершиться в неотрисовываемом документе.
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  draw(image, crop, hasIntrinsicSize(dataUrl));
  const pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
  let transparent = 0;
  let visible = 0;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 32) transparent++;
    if (pixels[i + 3] < 128) continue;
    visible++;
    const rgba = [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, 1];
    if (luminance(rgba) < 0.2 && isNeutral(toOklch(rgba))) dark++;
  }
  return transparent > SAMPLE * SAMPLE * 0.2 && visible > 0 && dark / visible > 0.9;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'offscreen-icon') return false;
  isDarkIcon(message).then(sendResponse, () => sendResponse(false));
  return true; // Канал остаётся открытым для асинхронного ответа.
});

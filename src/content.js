// content.js — точка входа в странице. Внедряется только в сайты из списка (см. background.js);
// запускает и останавливает движок по списку и главному выключателю. Фреймы следуют настройке
// верхнего сайта, в который они встроены.
//
// Основные функции:
//   apply()           прочитать настройки и включить или выключить тему
//   requestFrames()   попросить service worker внедрить скрипты во фреймы с других доменов

'use strict';

const topOrigin = location.ancestorOrigins[location.ancestorOrigins.length - 1];
const key = siteKey(URL.parse(topOrigin ?? '')?.hostname || location.hostname);

let applied = false;

// Список или главный выключатель могут измениться при открытой странице: тема следует за ними сразу.
const apply = async () => {
  const settings = await chrome.storage.local.get({ ...DEFAULTS, [key]: null });
  const next = settings.enabled && settings[key] === 'on';
  if (next === applied) return;
  if (next) Engine.start(PALETTE);
  else Engine.stop();
  applied = next;
  if (next && window === top && document.querySelector('iframe')) requestFrames();
};

// Фреймы с других доменов не входят в регистрацию, пока их домен неизвестен: верхний фрейм просит
// service worker внедрить в них скрипты при каждой (пере)загрузке фрейма. Один запрос за раз;
// фреймы, загрузившиеся тем временем, покрывает ещё один запрос сразу после.
let framesBusy = false;
let framesPending = false;
const requestFrames = async () => {
  framesPending = true;
  if (framesBusy) return;
  framesBusy = true;
  while (framesPending) {
    framesPending = false;
    await ask({ type: 'frames' }).catch(() => {});
  }
  framesBusy = false;
};

if (window === top) {
  document.addEventListener('load', (event) => applied && event.target.nodeName === 'IFRAME' && requestFrames(), true);
}

apply();
// Только свой сайт и выключатель: записи других сайтов и доменов фреймов эту страницу не касаются.
chrome.storage.onChanged.addListener((changes, area) => area === 'local' && ('enabled' in changes || key in changes) && apply());

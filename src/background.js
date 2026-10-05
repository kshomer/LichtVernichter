// background.js — service worker расширения.
//
// Основные функции:
//   registerScripts()        content scripts только для сайтов списка и доменов их фреймов
//   injectIntoTab(tabId)     внедрение в открытую вкладку, запоминание доменов фреймов
//   isDarkIcon(url, crop)    загрузка иконки и вердикт offscreen-документа «тёмная или нет»
//   fetchStylesheet(url)     текст таблицы стилей с другого домена (только text/css)
//   updateBadge()            бейдж «выкл» при выключенном расширении

'use strict';

importScripts('common.js');

const MAX_ICON_BYTES = 1_000_000;
const MAX_CSS_BYTES = 2_000_000;
const SCRIPT_ID = 'lichtvernichter';
const iconChecks = new Map();
let offscreen = null;

const toDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Растеризует изображения offscreen-документ: service worker не умеет декодировать SVG.
const ensureOffscreen = () =>
  (offscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Rasterizes icons to detect dark monochrome images that must be inverted on dark pages.',
    })
    .catch((error) => {
      // Уже открыт: например, service worker перезапустился, а документ остался.
      if (/single offscreen/i.test(error.message)) return;
      offscreen = null; // Следующая иконка попробует снова.
      throw error;
    }));

// Из расширения выходит только ответ «да/нет», не данные изображения. Адреса http(s) и data:, без cookies.
const isDarkIcon = async (url, crop) => {
  if (!/^(?:https?|data):$/.test(URL.parse(url)?.protocol)) return false;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return false;
  const blob = await response.blob();
  if (blob.size > MAX_ICON_BYTES) return false;
  const dataUrl = await toDataUrl(blob);
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: 'offscreen-icon', dataUrl, crop });
};

// Текст таблицы стилей с другого домена: странице её можно применить, но не прочитать. Движку нужны
// её селекторы, чтобы знать, какие элементы затрагивает новая таблица. Только http(s), без cookies и
// только ответ с типом text/css — как у самого браузера: иначе страница могла бы получить через
// расширение текст любого адреса.
const fetchStylesheet = async (url) => {
  if (!/^https?:$/.test(URL.parse(url)?.protocol)) return null;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok || !/^text\/css\b/i.test(response.headers.get('content-type') ?? '')) return null;
  const text = await response.text();
  return text.length <= MAX_CSS_BYTES ? text : null;
};

const checkIcon = ({ url, crop }) => {
  const key = JSON.stringify([url, crop]);
  if (!iconChecks.has(key)) iconChecks.set(key, isDarkIcon(url, crop).catch(() => false));
  return iconChecks.get(key);
};

// Запросы скриптов страниц из списка: иконка, таблица стилей, фреймы (верхний фрейм сообщает о новых
// или перезагруженных фреймах). Ответ асинхронный: `true` держит канал открытым.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  let answer;
  if (message?.type === 'icon') answer = checkIcon(message);
  else if (message?.type === 'stylesheet') answer = fetchStylesheet(message.url).catch(() => null);
  else if (message?.type === 'frames' && sender.tab) answer = injectIntoTab(sender.tab.id).then(() => true, () => false);
  else return false; // Например, 'offscreen-icon': на него отвечает offscreen-документ.
  answer.then(sendResponse);
  return true;
});

const updateBadge = async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: DEFAULTS.enabled });
  chrome.action.setBadgeText({ text: enabled ? '' : chrome.i18n.getMessage('badgeOff') });
};

// Сайты списка и домены фреймов, встроенных в них (frame:<домен> = сайт из списка, который его
// встраивает): встроенные дашборды и виджеты тёмные с первой отрисовки. Домен фрейма, открытый сам по
// себе, тоже получает скрипты, но они бездействуют: его верхний сайт не в списке.
const readList = async () => {
  const all = await chrome.storage.local.get(null);
  const listed = Object.keys(all)
    .filter((name) => name.startsWith('site:') && all[name] === 'on')
    .map((name) => name.slice('site:'.length));
  const frames = Object.keys(all)
    .filter((name) => name.startsWith('frame:') && listed.includes(all[name]))
    .map((name) => name.slice('frame:'.length));
  return { enabled: all.enabled ?? DEFAULTS.enabled, hosts: listed, frames };
};

// Шаблоны адресов для сайта: с www и без (порт шаблоны не учитывают). У IP-адреса нет варианта с
// www: такой шаблон недопустим и сорвал бы регистрацию.
const IP_ADDRESS = /^(\d+\.){3}\d+$|^\[/;
const patternsFor = (host) => (IP_ADDRESS.test(host) ? [host] : [host, `www.${host}`]).map((h) => `*://${h}/*`);

// Content scripts существуют только для сайтов списка: на остальных Chrome не загружает ничего.
// Регистрация переживает перезапуск браузера; здесь она приводится в соответствие с сохранённым
// списком. Существующая регистрация обновляется на месте: снятие и повторная регистрация оставляли
// бы промежуток, в который загружаемая страница сайта из списка осталась бы без темы.
const registerScripts = async () => {
  const { enabled, hosts, frames } = await readList();
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
  if (!enabled || !hosts.length) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const script = {
    id: SCRIPT_ID,
    matches: [...new Set([...hosts, ...frames])].flatMap(patternsFor),
    js: CONTENT_SCRIPTS,
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
  };
  await (registered ? chrome.scripting.updateContentScripts([script]) : chrome.scripting.registerContentScripts([script]));
};

// Внедряет скрипты во все фреймы вкладки, где их ещё нет: открытые вкладки нового сайта из списка
// темнеют сразу. Фреймы, где скрипты уже есть (движок — глобальная переменная изолированного мира
// расширения), пропускаются. Фреймы с других доменов следуют верхнему сайту; их домены
// запоминаются для регистрации (см. readList).
const injectIntoTab = async (tabId) => {
  const probes = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => [typeof Engine !== 'undefined', location.hostname] })
    .catch(() => []);
  const frameIds = probes.filter(({ result }) => result?.[0] === false).map((probe) => probe.frameId);
  if (frameIds.length) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds }, files: CONTENT_SCRIPTS }).catch(() => {});
  }
  const top = probes.find((probe) => probe.frameId === 0)?.result?.[1];
  const site = top && siteKey(top).slice('site:'.length);
  const embedded = probes
    .filter(({ frameId, result }) => frameId !== 0 && result?.[1] && siteKey(result[1]) !== siteKey(top ?? ''))
    .map(({ result }) => siteKey(result[1]).slice('site:'.length));
  if (!site || !embedded.length) return;
  const known = await chrome.storage.local.get(embedded.map((host) => `frame:${host}`));
  const fresh = embedded.filter((host) => known[`frame:${host}`] !== site);
  if (fresh.length) await chrome.storage.local.set(Object.fromEntries(fresh.map((host) => [`frame:${host}`, site])));
};

const injectIntoOpenTabs = async (hosts) => {
  for (const tab of await chrome.tabs.query({ url: hosts.flatMap(patternsFor) })) await injectIntoTab(tab.id);
};

// Изменения хранилища приходят сериями; регистрации применяются строго одна за другой.
let syncing = Promise.resolve();
const sync = (addedHosts = []) => {
  syncing = syncing
    .then(registerScripts)
    .then(() => addedHosts.length && injectIntoOpenTabs(addedHosts))
    .catch(() => {});
  return syncing;
};

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const sites = Object.keys(changes).filter((name) => name.startsWith('site:') || name.startsWith('frame:'));
  if ('enabled' in changes) updateBadge();
  else if (!sites.length) return;
  // Включение расширения затемняет открытые вкладки всех сайтов списка; иначе скрипты нужны только
  // только что добавленным.
  const added = changes.enabled?.newValue
    ? (await readList()).hosts
    : sites.filter((name) => changes[name].newValue === 'on').map((name) => name.slice('site:'.length));
  sync(added);
});

// Запуск браузера, установка и обновление: бейдж и регистрация по сохранённому списку.
const init = () => {
  updateBadge();
  sync();
};
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

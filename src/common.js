// common.js — общие значения для content scripts, popup и service worker.
//
// Содержит:
//   DEFAULTS          настройки по умолчанию (отсутствующие ключи хранилища берут эти значения)
//   PALETTE           цвета тёмной темы — палитра Material Design
//   siteKey(host)     ключ сайта в хранилище: site:<домен без www>
//   CONTENT_SCRIPTS   скрипты, внедряемые в сайты из списка, по порядку
//   ask(message)      сообщение расширению без исключений (Promise)

'use strict';

const DEFAULTS = Object.freeze({ enabled: true });

// Цвета тёмной темы: тёмная поверхность, текст и полоса прокрутки Material Design (Google).
const PALETTE = Object.freeze({ surface: '#202124', text: '#e8eaed', scrollbar: '#5f6368' });

// «www.ozon.ru» и «ozon.ru» — один сайт: в ключе приставка www отбрасывается.
const siteKey = (host) => `site:${host.replace(/^www\./, '')}`;

// Скрипты для сайтов из списка, по порядку: общие значения, цветовая математика, движок, точка входа.
const CONTENT_SCRIPTS = Object.freeze(['common.js', 'color.js', 'engine.js', 'content.js']);

// Сообщение расширению из страницы. Если расширение перезагрузили, скрипт, оставшийся в открытой
// вкладке, теряет связь с ним: chrome.runtime становится undefined, и прямой вызов sendMessage
// бросал бы ошибку синхронно, мимо .catch. async превращает любую ошибку в отклонённый Promise.
const ask = async (message) => chrome.runtime.sendMessage(message);

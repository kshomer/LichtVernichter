// popup.js — окно настроек: главный выключатель и переключатель «тёмная тема на этом сайте».
// Переводит подписи, показывает сохранённое состояние, записывает изменения в хранилище.

const form = document.forms.settings;
const { elements } = form;

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
}
for (const el of document.querySelectorAll('[data-i18n-label]')) {
  el.ariaLabel = chrome.i18n.getMessage(el.dataset.i18nLabel);
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = URL.parse(tab?.url ?? '');
const key = siteKey(url?.hostname ?? '');
// В список можно добавить только веб-сайт: на своих страницах и в Web Store Chrome блокирует расширения.
const scriptable = /^https?:$/.test(url?.protocol) && url.hostname !== 'chromewebstore.google.com';
elements.host.value = url?.hostname ?? '';

const showEnabled = () => {
  elements.site.disabled = !scriptable || !elements.enabled.checked;
};

const settings = await chrome.storage.local.get({ ...DEFAULTS, [key]: null });
elements.enabled.checked = settings.enabled;
elements.site.checked = settings[key] === 'on';
showEnabled();
// Переключатели открываются выключенными, а состояние приходит из хранилища асинхронно: без этого
// при каждом открытии окна они анимировались бы «выкл → вкл». Чтение размера заставляет браузер
// применить состояние сейчас, без переходов; класс ready включает переходы уже для действий пользователя.
document.body.getBoundingClientRect();
document.body.classList.add('ready');

// Сайт в списке, пока есть его ключ; удаление не оставляет записи.
form.addEventListener('input', ({ target: { name, checked } }) => {
  if (name === 'enabled') {
    chrome.storage.local.set({ enabled: checked });
    showEnabled();
  } else if (checked) {
    chrome.storage.local.set({ [key]: 'on' });
  } else {
    chrome.storage.local.remove(key);
  }
});

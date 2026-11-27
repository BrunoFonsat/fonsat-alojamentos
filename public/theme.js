// Tema claro/escuro/automático. Corre antes de a página aparecer (evita o «flash» de cor errada).
(function () {
  var KEY = 'aloj.theme', mq = window.matchMedia('(prefers-color-scheme: dark)');
  function pref() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref(), d = document.documentElement;
    d.dataset.themePref = p;
    d.dataset.theme = p === 'auto' ? (mq.matches ? 'dark' : 'light') : p;
  }
  window.setTheme = function (p) { try { localStorage.setItem(KEY, p); } catch (e) { /* sem armazenamento */ } apply(); document.dispatchEvent(new Event('themechange')); };
  if (mq.addEventListener) mq.addEventListener('change', function () { if (pref() === 'auto') { apply(); document.dispatchEvent(new Event('themechange')); } });
  apply();
})();

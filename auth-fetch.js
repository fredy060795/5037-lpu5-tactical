/* LPU5: attach the session token to every same-origin /api request.
 * The server requires a token for all changes (security.py); older pages
 * did not always send one. Included in all HTML pages. */
(function () {
  if (window.__lpu5AuthFetch) return;
  window.__lpu5AuthFetch = true;
  function token() {
    try { return localStorage.getItem('token') || localStorage.getItem('authToken') || ''; } catch (e) { return ''; }
  }
  function isApi(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.indexOf('/api/') === 0;
    } catch (e) { return false; }
  }
  function onAuthError(res) {
    if (res.status === 403) {
      res.clone().json().then(function (b) {
        if (b && (b.message === 'PASSWORD_CHANGE_REQUIRED' || b.detail === 'PASSWORD_CHANGE_REQUIRED')) {
          if (!/change_password\.html/.test(location.pathname)) location.href = '/change_password.html?next=' + encodeURIComponent(location.pathname + location.hash);
        }
      }).catch(function () {});
    }
    return res;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (isApi(url) && token()) {
      init = init || {};
      var headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token());
      init.headers = headers;
    }
    return origFetch.call(this, input, init).then(onAuthError);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lpu5Api = isApi(url);
    return origOpen.apply(this, arguments);
  };
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') this.__lpu5HasAuth = true;
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__lpu5Api && !this.__lpu5HasAuth && token()) origSetHeader.call(this, 'Authorization', 'Bearer ' + token());
    return origSend.apply(this, arguments);
  };
})();

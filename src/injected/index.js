import 'src/common/browser';
import { isFirefox } from 'src/common/ua';
import { inject, getUniqId, sendMessage } from './utils';
import initialize from './content';

(function main() {
  // Avoid running repeatedly due to new `document.documentElement`
  if (window.VM) return;
  window.VM = 1;

  function initBridge() {
    const contentId = getUniqId();
    const webId = getUniqId();
    initialize(contentId, webId).then(needInject => {
      if (needInject) {
        doInject(contentId, webId);
      }
    });
  }

  function doInject(contentId, webId) {
    const props = {};
    [
      Object.getOwnPropertyNames(window),
      Object.getOwnPropertyNames(global),
    ].forEach(keys => {
      keys.forEach(key => { props[key] = 1; });
    });
    const args = [
      webId,
      contentId,
      Object.keys(props),
    ];
    const init = window[process.env.INIT_FUNC_NAME];
    if (isFirefox) {
      // In Firefox, unsafeWindow = window.wrappedJSObject
      // So we don't need to inject the scripts into page context
      init()(...args);
    } else {
      // Avoid using Function::apply in case it is shimmed
      inject(`(${init.toString()}())(${args.map(arg => JSON.stringify(arg)).join(',')})`);
    }
  }

  initBridge();

  // For installation
  // Firefox does not support `onBeforeRequest` for `file:`
  function checkJS() {
    if (!document.querySelector('title')) {
      // plain text
      sendMessage({
        cmd: 'ConfirmInstall',
        data: {
          code: document.body.textContent,
          url: window.location.href,
          from: document.referrer,
        },
      })
      .then(() => {
        if (window.history.length > 1) window.history.go(-1);
        else sendMessage({ cmd: 'TabClose' });
      });
    }
  }
  if (/\.user\.js$/.test(window.location.pathname)) {
    if (document.readyState === 'complete') checkJS();
    else window.addEventListener('load', checkJS, false);
  }
}());

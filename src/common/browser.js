// Since this also runs in a content script we'll guard against implicit global variables
// for DOM elements with 'id' attribute which is a standard feature, more info:
// https://github.com/mozilla/webextension-polyfill/pull/153
// https://html.spec.whatwg.org/multipage/window-object.html#named-access-on-the-window-object
if (!global.browser?.runtime?.sendMessage) {
  // region Chrome
  const { chrome, Error, Promise, Proxy } = global;
  const { bind } = Proxy;
  /** onXXX like onMessage */
  const isApiEvent = key => key[0] === 'o' && key[1] === 'n';
  /** API types or enums or literal constants */
  const isFunction = val => typeof val === 'function';
  const isObject = val => typeof val === 'object';
  const wrapAsync = (thisArg, func, preprocessorFunc) => (
    (...args) => {
      let resolve;
      let reject;
      /* Using resolve/reject to call API in the scope of this function, not inside Promise,
         because an API validation exception is thrown synchronously both in Chrome and FF
         so the caller can use try/catch to detect it like we've been doing in icon.js */
      const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
      });
      // Make the error messages actually useful by capturing a real stack
      const stackInfo = new Error();
      thisArg::func(...args, (response) => {
        let err = chrome.runtime.lastError;
        if (err) {
          err = err.message;
        } else if (preprocessorFunc) {
          err = preprocessorFunc(resolve, response);
        } else {
          resolve(response);
        }
        // Prefer `reject` over `throw` which stops debugger in 'pause on exceptions' mode
        if (err) reject(new Error(`${err}\n${stackInfo.stack}`));
      });
      if (process.env.DEBUG) promise.catch(err => console.warn(args, err?.message || err));
      return promise;
    }
  );
  const sendResponseAsync = async (result, sendResponse) => {
    try {
      result = await result;
      if (process.env.DEBUG) console.info('send', result);
      sendResponse({ data: result });
    } catch (err) {
      if (process.env.DEBUG) console.warn(err);
      sendResponse({ error: err instanceof Error ? err.stack : err });
    }
  };
  const wrapMessageListener = (listener, message, sender, sendResponse) => {
    if (process.env.DEBUG) console.info('receive', message);
    const result = listener(message, sender);
    if (result && isFunction(result.then)) {
      sendResponseAsync(result, sendResponse);
      return true;
    }
    if (result !== undefined) {
      // In some browsers (e.g Chrome 56, Vivaldi), the listener in
      // popup pages are not properly cleared after closed.
      // They may send `undefined` before the real response is sent.
      sendResponse({ data: result });
    }
  };
  /** @returns {?} error */
  const unwrapResponse = (resolve, response) => (
    !response && 'null response'
    || response.error
    || resolve(response.data)
  );
  const proxifyValue = (target, key, groupName, src, metaVal) => {
    const srcVal = src[key];
    if (srcVal === undefined) return;
    let res;
    if (metaVal === 0) {
      res = isFunction(srcVal)
        ? srcVal::bind(src)
        : srcVal;
    } else if (isFunction(srcVal)) {
      if (!isApiEvent(groupName)) {
        res = wrapAsync(src, srcVal, metaVal);
      } else if (metaVal) {
        res = listener => src::srcVal(metaVal::bind(null, listener));
      } else {
        res = srcVal::bind(src);
      }
    } else if (isObject(srcVal)) {
      res = proxifyGroup(key, srcVal, metaVal); // eslint-disable-line no-use-before-define
    } else {
      res = srcVal;
    }
    target[key] = res;
    return res;
  };
  const proxifyGroup = (groupName, src, meta) => new Proxy({}, {
    get: (target, key) => (
      target[key]
      ?? proxifyValue(target, key, groupName, src, meta?.[key])
    ),
  });
  /**
   * 0 = non-async method or the entire group
   * function = preprocessor,
   *   for onXXX methods: (listener, ...originalArgs): void
   *   for async methods: (resolve, data): any - a truthy return value goes into reject()
   */
  global.browser = proxifyGroup('', chrome, {
    extension: 0, // we don't use its async methods
    i18n: 0, // we don't use its async methods
    runtime: {
      connect: 0,
      getManifest: 0,
      getURL: 0,
      onMessage: {
        addListener: wrapMessageListener,
      },
      sendMessage: unwrapResponse,
    },
    tabs: {
      connect: 0,
      sendMessage: unwrapResponse,
    },
  });
  // endregion
} else if (process.env.DEBUG && !global.chrome.app) {
  // region Firefox
  let counter = 0;
  const { runtime } = global.browser;
  const { sendMessage, onMessage } = runtime;
  const log = (type, args, id, isResponse) => console.info(
    `%c${type}Message#%d${isResponse ? ' response' : ''}`,
    isResponse ? '' : 'color:yellow',
    id,
    ...args,
  );
  runtime.sendMessage = (...args) => {
    counter += 1;
    const id = counter;
    log('send', args, id);
    const promise = runtime::sendMessage(...args);
    promise.then(data => log('send', [data], id, true), console.warn);
    return promise;
  };
  const { addListener } = onMessage;
  onMessage.addListener = (listener) => onMessage::addListener((msg, sender) => {
    counter += 1;
    const id = counter;
    const { frameId, tab, url } = sender;
    log('on', [msg, { frameId, tab, url }], id);
    const result = listener(msg, sender);
    (typeof result?.then === 'function' ? result : Promise.resolve(result))
    .then(data => log('on', [data], id, true), console.warn);
    return result;
  });
  // endregion
}

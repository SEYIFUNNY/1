/* eslint-disable one-var, one-var-declaration-per-line, no-unused-vars,
   prefer-const, import/no-mutable-exports */

/**
 * `safeCall` is used by our modified babel-plugin-safe-bind.js.
 * `export` is stripped in the final output and is only used for our NodeJS test scripts.
 */

export let
  // window
  SafeCustomEvent,
  SafeDOMParser,
  SafeError,
  SafeEventTarget,
  SafeFileReader,
  SafeJSONParse,
  SafeJSONStringify,
  SafeKeyboardEvent,
  SafeMouseEvent,
  Object,
  SafePromise,
  SafeProxy,
  SafeResponse,
  SafeSymbol,
  fire,
  off,
  on,
  // Symbol
  toStringTagSym,
  // Object
  apply,
  assign,
  bind,
  defineProperty,
  describeProperty,
  getOwnPropertyNames,
  getOwnPropertySymbols,
  objectKeys,
  objectValues,
  // Object.prototype
  hasOwnProperty,
  objectToString,
  /** Array.prototype can be eavesdropped via setters like '0','1',...
   * on `push` and `arr[i] = 123`, as well as via getters if you read beyond
   * its length or from an unassigned `hole`. */
  concat,
  filter,
  forEach,
  indexOf,
  // Element.prototype
  remove,
  // String.prototype
  charCodeAt,
  slice,
  // safeCall
  safeCall,
  // various methods
  createObjectURL,
  funcToString,
  ArrayIsArray,
  logging,
  mathRandom,
  parseFromString, // DOMParser
  readAsDataURL, // FileReader
  safeResponseBlob, // Response - safe = "safe global" to disambiguate the name
  stopImmediatePropagation,
  then,
  // various getters
  getBlobType, // Blob
  getCurrentScript, // Document
  getDetail, // CustomEvent
  getReaderResult, // FileReader
  getRelatedTarget; // MouseEvent

/**
 * VAULT consists of the parent's safe globals to protect our communications/globals
 * from a page that creates an iframe with src = location and modifies its contents
 * immediately after adding it to DOM via direct manipulation in frame.contentWindow
 * or window[0] before our content script runs at document_start, https://crbug.com/1261964 */
export const VAULT = (() => {
  let ArrayP;
  let ElementP;
  let SafeObject;
  let StringP;
  let i = -1;
  let call;
  let res;
  let src = global; // FF defines some stuff only on `global` in content mode
  if (process.env.VAULT_ID) {
    res = window[process.env.VAULT_ID];
    delete window[process.env.VAULT_ID];
  }
  if (!res) {
    res = createNullObj();
  } else if (!isFunction(res[0])) {
    src = res[0];
    res = createNullObj();
  }
  res = [
    // window
    SafeCustomEvent = res[i += 1] || src.CustomEvent,
    SafeDOMParser = res[i += 1] || src.DOMParser,
    SafeError = res[i += 1] || src.Error,
    SafeEventTarget = res[i += 1] || src.EventTarget,
    SafeFileReader = res[i += 1] || src.FileReader,
    SafeJSONParse = res[i += 1] || src.JSON.parse,
    SafeJSONStringify = res[i += 1] || src.JSON.stringify,
    SafeKeyboardEvent = res[i += 1] || src.KeyboardEvent,
    SafeMouseEvent = res[i += 1] || src.MouseEvent,
    Object = res[i += 1] || src.Object,
    SafePromise = res[i += 1] || src.Promise,
    SafeSymbol = res[i += 1] || src.Symbol,
    // In FF content mode global.Proxy !== window.Proxy
    SafeProxy = res[i += 1] || src.Proxy,
    SafeResponse = res[i += 1] || src.Response,
    fire = res[i += 1] || src.dispatchEvent,
    off = res[i += 1] || src.removeEventListener,
    on = res[i += 1] || src.addEventListener,
    // Object - using SafeObject to pacify eslint without disabling the rule
    defineProperty = (SafeObject = Object) && res[i += 1] || SafeObject.defineProperty,
    describeProperty = res[i += 1] || SafeObject.getOwnPropertyDescriptor,
    getOwnPropertyNames = res[i += 1] || SafeObject.getOwnPropertyNames,
    getOwnPropertySymbols = res[i += 1] || SafeObject.getOwnPropertySymbols,
    assign = res[i += 1] || SafeObject.assign,
    objectKeys = res[i += 1] || SafeObject.keys,
    objectValues = res[i += 1] || SafeObject.values,
    apply = res[i += 1] || SafeObject.apply,
    bind = res[i += 1] || SafeObject.bind,
    // Object.prototype
    hasOwnProperty = res[i += 1] || SafeObject[PROTO].hasOwnProperty,
    objectToString = res[i += 1] || SafeObject[PROTO].toString,
    // Array.prototype
    concat = res[i += 1] || (ArrayP = src.Array[PROTO]).concat,
    filter = res[i += 1] || ArrayP.filter,
    forEach = res[i += 1] || ArrayP.forEach,
    indexOf = res[i += 1] || ArrayP.indexOf,
    // Element.prototype
    remove = res[i += 1] || (ElementP = src.Element[PROTO]).remove,
    // String.prototype
    charCodeAt = res[i += 1] || (StringP = src.String[PROTO]).charCodeAt,
    slice = res[i += 1] || StringP.slice,
    // safeCall
    safeCall = res[i += 1] || (call = SafeObject.call).bind(call),
    // various methods
    createObjectURL = res[i += 1] || src.URL.createObjectURL,
    funcToString = res[i += 1] || safeCall.toString,
    ArrayIsArray = res[i += 1] || src.Array.isArray,
    logging = res[i += 1] || assign(createNullObj(), src.console),
    mathRandom = res[i += 1] || src.Math.random,
    parseFromString = res[i += 1] || SafeDOMParser[PROTO].parseFromString,
    readAsDataURL = res[i += 1] || SafeFileReader[PROTO].readAsDataURL,
    safeResponseBlob = res[i += 1] || SafeResponse[PROTO].blob,
    stopImmediatePropagation = res[i += 1] || src.Event[PROTO].stopImmediatePropagation,
    then = res[i += 1] || SafePromise[PROTO].then,
    // various getters
    getBlobType = res[i += 1] || describeProperty(src.Blob[PROTO], 'type').get,
    getCurrentScript = res[i += 1] || describeProperty(src.Document[PROTO], 'currentScript').get,
    getDetail = res[i += 1] || describeProperty(SafeCustomEvent[PROTO], 'detail').get,
    getReaderResult = res[i += 1] || describeProperty(SafeFileReader[PROTO], 'result').get,
    getRelatedTarget = res[i += 1] || describeProperty(SafeMouseEvent[PROTO], 'relatedTarget').get,
  ];
  // Well-known Symbols are unforgeable
  toStringTagSym = SafeSymbol.toStringTag;
  return res;
})();

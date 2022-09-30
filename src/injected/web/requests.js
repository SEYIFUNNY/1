import bridge from './bridge';

/** @type {Object<string,VM.Xhr.Web>} */
const idMap = createNullObj();

bridge.addHandlers({
  /** @param {VM.Xhr.Message.BG} msg */
  HttpRequested(msg) {
    const req = idMap[msg.id];
    if (req) callback(req, msg);
  },
});

/**
 * @param {VM.Xhr.UserOpts} opts - must already have a null proto
 * @param {VM.Injected.Context} context
 * @param {string} fileName
 * @return {VMScriptXHRControl}
 */
export function onRequestCreate(opts, context, fileName) {
  if (process.env.DEBUG) throwIfProtoPresent(opts);
  let { url } = opts;
  if (url && !isString(url)) { // USVString in XMLHttpRequest spec calls ToString
    try {
      url = url::URLToString();
    } catch (e) {
      url = getOwnProp(url, 'href'); // `location`
    }
    opts.url = url;
  }
  if (!url) {
    const err = new SafeError('Required parameter "url" is missing.');
    const { onerror } = opts;
    if (isFunction(onerror)) onerror(err);
    else throw err;
  }
  const scriptId = context.id;
  const id = safeGetUniqId('VMxhr');
  /** @type {VM.Xhr.Web} */
  const req = {
    __proto__: null,
    id,
    scriptId,
    opts,
  };
  start(req, context, fileName);
  return {
    abort() {
      bridge.post('AbortRequest', id, context);
    },
  };
}

/**
 * @param {VM.Xhr.Web} req
 * @param {VM.Xhr.Message.BG} msg
 * @returns {string|number|boolean|Array|Object|Document|Blob|ArrayBuffer}
 */
function parseData(req, msg) {
  let res = req.raw;
  switch (req.opts.responseType) {
  case 'json':
    res = jsonParse(res);
    break;
  case 'document':
    res = new SafeDOMParser()::parseFromString(res, getContentType(msg) || 'text/html');
    break;
  default:
  }
  // `response` is sent only when changed so we need to remember it for response-less events
  req.response = res;
  // `raw` is decoded once per `response` change so we reuse the result just like native XHR
  delete req.raw;
  return res;
}

/**
 * Not using RegExp because it internally depends on proto stuff that can be easily broken,
 * and safe-guarding all of it is ridiculously disproportional.
 * @param {VM.Xhr.Message.BG} msg
 */
function getContentType(msg) {
  const type = msg.contentType || '';
  const len = type.length;
  let i = 0;
  let c;
  // Cutting everything after , or ; or whitespace
  while (i < len && (c = type[i]) !== ',' && c !== ';' && c > ' ') {
    i += 1;
  }
  return type::slice(0, i);
}

/**
 * @param {VM.Xhr.Web} req
 * @param {VM.Xhr.Message.BG} msg
 * @returns {*}
 */
function callback(req, msg) {
  const { opts } = req;
  const cb = opts[`on${msg.type}`];
  if (cb) {
    const { data } = msg;
    const {
      response,
      responseHeaders: headers,
      responseText: text,
    } = data;
    if (response && !('raw' in req)) {
      req.raw = response;
    }
    defineProperty(data, 'response', {
      __proto__: null,
      get() {
        const value = 'raw' in req ? parseData(req, msg) : req.response;
        defineProperty(this, 'response', { __proto__: null, value });
        return value;
      },
    });
    if (headers != null) req.headers = headers;
    if (text != null) req.text = getOwnProp(text, 0) === 'same' ? response : text;
    setOwnProp(data, 'context', opts.context);
    setOwnProp(data, 'responseHeaders', req.headers);
    setOwnProp(data, 'responseText', req.text);
    cb(data);
  }
  if (msg.type === 'loadend') delete idMap[req.id];
}

/**
 * @param {VM.Xhr.Web} req
 * @param {VM.Injected.Context} context
 * @param {string} fileName
 */
function start(req, context, fileName) {
  const { id, opts, scriptId } = req;
  // withCredentials is for GM4 compatibility and used only if `anonymous` is not set,
  // it's true by default per the standard/historical behavior of gmxhr
  const { data, withCredentials = true, anonymous = !withCredentials } = opts;
  idMap[id] = req;
  /** @type {VM.Xhr.Message.Web} */
  bridge.post('HttpRequest', createNullObj({
    id,
    scriptId,
    anonymous,
    fileName,
    data: data == null && []
      // `binary` is for TM/GM-compatibility + non-objects = must use a string `data`
      || (opts.binary || !isObject(data)) && [`${data}`]
      // FF56+ can send any cloneable data directly, FF52-55 can't due to https://bugzil.la/1371246
      || IS_FIREFOX && bridge.ua.browserVersion >= 56 && [data]
      || getFormData(data)
      || [data, 'bin'],
    eventsToNotify: [
      'abort',
      'error',
      'load',
      'loadend',
      'loadstart',
      'progress',
      'readystatechange',
      'timeout',
    ]::filter(key => isFunction(getOwnProp(opts, `on${key}`))),
    xhrType: getResponseType(opts.responseType),
  }, opts, [
    'headers',
    'method',
    'overrideMimeType',
    'password',
    'timeout',
    'url',
    'user',
  ]), context);
}

/** Chrome can't directly transfer FormData to isolated world so we explode it,
 * trusting its iterator is usable because the only reason for a site to break it
 * is to fight a userscript, which it can do by breaking FormData constructor anyway */
function getFormData(data) {
  try {
    return [[...data::formDataEntries()], 'fd']; // eslint-disable-line no-restricted-syntax
  } catch (e) {
    /**/
  }
}

function getResponseType(responseType = '') {
  switch (responseType) {
  case 'arraybuffer':
  case 'blob':
    return responseType;
  case 'document':
  case 'json':
  case 'text':
  case '':
    break;
  default:
    log('warn', null, `Unknown responseType "${responseType}",`
      + ' see https://violentmonkey.github.io/api/gm/#gm_xmlhttprequest for more detail.');
  }
  return '';
}

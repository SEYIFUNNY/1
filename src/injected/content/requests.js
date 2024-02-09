import bridge, { addBackgroundHandlers, addHandlers, onScripts } from './bridge';
import { makeElem, sendCmd } from './util';

const {
  fetch: safeFetch,
  FileReader: SafeFileReader,
  FormData: SafeFormData,
} = global;
const { arrayBuffer: getArrayBuffer, blob: getBlob } = ResponseProto;
const { createObjectURL, revokeObjectURL } = URL;
const BlobProto = SafeBlob[PROTO];
const getBlobType = describeProperty(BlobProto, 'type').get;
const getTypedArrayBuffer = describeProperty(getPrototypeOf(SafeUint8Array[PROTO]), 'buffer').get;
const getReaderResult = describeProperty(SafeFileReader[PROTO], 'result').get;
const readAsDataURL = SafeFileReader[PROTO].readAsDataURL;
const fdAppend = SafeFormData[PROTO].append;
const CHUNKS = 'chunks';
const PROPS_TO_COPY = [
  kFileName,
  kXhrType,
];
/** @type {GMReq.Content} */
const requests = createNullObj();
let downloadChain = promiseResolve();
/** @type {()=>string} */
let getTabUserAgent;

onScripts.push(data => {
  if (data.xhr) {
    // The tab may have a different UA due to a devtools override or about:config
    getTabUserAgent = describeProperty(Navigator[PROTO], 'userAgent').get.bind(navigator);
  }
});

// TODO: extract all prop names used across files into consts.js to ensure sameness
addHandlers({
  /**
   * @param {GMReq.Message.Web} msg
   * @param {VMScriptInjectInto} realm
   * @returns {Promise<void>}
   */
  async HttpRequest(msg, realm) {
    requests[msg.id] = safePickInto({
      realm,
    }, msg, PROPS_TO_COPY);
    let { data } = msg;
    // In Firefox we recreate FormData in bg::decodeBody
    if (!IS_FIREFOX && data.length > 1 && data[1] !== 'usp') {
      // TODO: support huge data by splitting it to multiple messages
      data = await encodeBody(data[0], data[1]);
      msg.data = cloneInto ? cloneInto(data, msg) : data;
    }
    msg.ua = getTabUserAgent();
    return sendCmd('HttpRequest', msg);
  },
  AbortRequest: true,
});

addBackgroundHandlers({
  /**
   * @param {GMReq.Message.BG} msg
   * @returns {Promise<void>}
   */
  async HttpRequested(msg) {
    const { id, data } = msg;
    const req = requests[id];
    if (!req) {
      if (process.env.DEV) console.warn('[HttpRequested][content]: no request for id', id);
      return;
    }
    if (hasOwnProperty(msg, 'chunk')) {
      processChunk(req, data, msg);
      return;
    }
    let response = data?.[kResponse];
    if (response != null) {
      if (msg.blobbed) {
        response = await importBlob(req, response);
      } else if (msg.chunked) {
        processChunk(req, response);
        response = req[CHUNKS];
        delete req[CHUNKS];
        if (req[kXhrType] === 'blob') {
          response = new SafeBlob([response], { type: msg.contentType });
        } else if (req[kXhrType]) {
          response = response::getTypedArrayBuffer();
        } else {
          // sending text chunks as-is to avoid memory overflow due to concatenation
        }
      }
      data[kResponse] = response;
    }
    if (response && req[kFileName]) {
      req[kResponse] = response;
    }
    if (msg.type === 'load' && req[kFileName]) {
      await downloadBlob(req[kResponse], req[kFileName]);
    }
    if (msg.type === 'loadend') {
      delete requests[msg.id];
    }
    bridge.post('HttpRequested', msg, req.realm);
  },
});

/**
 * Only a content script can read blobs from an extension:// URL
 * @param {GMReq.Content} req
 * @param {string} url
 * @returns {Promise<Blob|ArrayBuffer>}
 */
async function importBlob(req, url) {
  const data = await (await safeFetch(url))::(req[kXhrType] === 'blob' ? getBlob : getArrayBuffer)();
  sendCmd('RevokeBlob', url);
  return data;
}

function downloadBlob(blob, fileName) {
  const url = createObjectURL(blob);
  const a = makeElem('a', {
    href: url,
    download: fileName,
  });
  const res = downloadChain::then(() => {
    a::fire(new SafeMouseEvent('click'));
    revokeBlobAfterTimeout(url);
  });
  // Frequent downloads are ignored in Chrome and possibly other browsers
  downloadChain = res::then(() => sendCmd('SetTimeout', 150));
  return res;
}

async function revokeBlobAfterTimeout(url) {
  await sendCmd('SetTimeout', 3000);
  revokeObjectURL(url);
}

/**
 * @param {GMReq.Content} req
 * @param {string} data
 * @param {GMReq.Message.BGChunk} [msg]
 */
function processChunk(req, data, msg) {
  if (!req[kXhrType]) {
    setOwnProp(req[CHUNKS] || (req[CHUNKS] = ['']), msg ? msg.i : 0, data);
    return;
  }
  data = safeAtob(data);
  const len = data.length;
  const arr = req[CHUNKS] || (req[CHUNKS] = new SafeUint8Array(msg ? msg.size : len));
  for (let pos = msg?.chunk || 0, i = 0; i < len;) {
    arr[pos++] = safeCharCodeAt(data, i++);
  }
}

/** Doing it here because vault's SafeResponse+blob() doesn't work in injected-web */
async function encodeBody(body, mode) {
  if (mode === 'fd') {
    if (!body.length) { // see decodeBody comments about FormData in Chrome
      return [body, mode];
    }
    const fd = new SafeFormData();
    body::forEach(entry => fd::fdAppend(entry[0], entry[1]));
    body = fd;
  }
  const wasBlob = isInstance(body, BlobProto);
  const blob = wasBlob ? body : await new SafeResponse(body)::getBlob();
  const reader = new SafeFileReader();
  return new SafePromise(resolve => {
    reader::on('load', () => resolve([
      reader::getReaderResult(),
      blob::getBlobType(),
      wasBlob,
    ]));
    reader::readAsDataURL(blob);
  });
}

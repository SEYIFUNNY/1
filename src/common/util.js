import { forEachEntry } from './object';

// used in an unsafe context so we need to save the original functions
const perfNow = performance.now.bind(performance);
const { random, floor } = Math;
export const { toString: numberToString } = Number.prototype;

export function toString(param) {
  if (param == null) return '';
  return `${param}`;
}

export function memoize(func, resolver = toString) {
  const cacheMap = {};
  function memoized(...args) {
    const key = resolver(...args);
    let cache = cacheMap[key];
    if (!cache) {
      cache = {
        value: func.apply(this, args),
      };
      cacheMap[key] = cache;
    }
    return cache.value;
  }
  return memoized;
}

export function debounce(func, time) {
  let startTime;
  let timer;
  let callback;
  time = Math.max(0, +time || 0);
  function checkTime() {
    timer = null;
    if (perfNow() >= startTime) callback();
    else checkTimer();
  }
  function checkTimer() {
    if (!timer) {
      const delta = startTime - perfNow();
      timer = setTimeout(checkTime, delta);
    }
  }
  function debouncedFunction(...args) {
    startTime = perfNow() + time;
    callback = () => {
      callback = null;
      func.apply(this, args);
    };
    checkTimer();
  }
  return debouncedFunction;
}

export function throttle(func, time) {
  let lastTime = 0;
  time = Math.max(0, +time || 0);
  function throttledFunction(...args) {
    const now = perfNow();
    if (lastTime + time < now) {
      lastTime = now;
      func.apply(this, args);
    }
  }
  return throttledFunction;
}

export function noop() {}

export function getRnd4() {
  return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(-4);
}

export function getUniqId(prefix = 'VM') {
  const now = perfNow();
  return prefix
    + floor((now - floor(now)) * 1e12)::numberToString(36)
    + floor(random() * 1e12)::numberToString(36);
}

export function buffer2string(buf, offset = 0, length = 1e99) {
  // The max number of arguments varies between JS engines but it's >32k so we're safe
  const sliceSize = 8192;
  const slices = [];
  const end = Math.min(buf.byteLength, offset + length);
  for (; offset < end; offset += sliceSize) {
    slices.push(String.fromCharCode.apply(null,
      new Uint8Array(buf, offset, Math.min(sliceSize, end - offset))));
  }
  return slices.join('');
}

export function compareVersion(ver1, ver2) {
  const parts1 = (ver1 || '').split('.');
  const parts2 = (ver2 || '').split('.');
  for (let i = 0; i < parts1.length || i < parts2.length; i += 1) {
    const delta = (parseInt(parts1[i], 10) || 0) - (parseInt(parts2[i], 10) || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

const units = [
  ['min', 60],
  ['h', 24],
  ['d', 1000, 365],
  ['y'],
];
export function formatTime(duration) {
  duration /= 60 * 1000;
  const unitInfo = units.find((item) => {
    const max = item[1];
    if (!max || duration < max) return true;
    const step = item[2] || max;
    duration /= step;
    return false;
  });
  return `${duration | 0}${unitInfo[0]}`;
}

// used in an unsafe context so we need to save the original functions
export const { hasOwnProperty } = Object.prototype;
export function isEmpty(obj) {
  for (const key in obj) {
    if (obj::hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}

export function ensureArray(data) {
  return Array.isArray(data) ? data : [data];
}

const binaryTypes = [
  'blob',
  'arraybuffer',
];

/**
 * Make a request.
 * @param {string} url
 * @param {RequestInit} options
 * @return Promise
 */
export function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const { responseType } = options;
    xhr.open(options.method || 'GET', url, true);
    if (binaryTypes.includes(responseType)) xhr.responseType = responseType;
    const headers = Object.assign({}, options.headers);
    let { body } = options;
    if (body && Object.prototype.toString.call(body) === '[object Object]') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    headers::forEachEntry(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.onload = () => {
      const res = getResponse(xhr, {
        // status for `file:` protocol will always be `0`
        status: xhr.status || 200,
      });
      if (res.status > 300) {
        reject(res);
      } else {
        resolve(res);
      }
    };
    xhr.onerror = () => {
      const res = getResponse(xhr, { status: -1 });
      reject(res);
    };
    xhr.onabort = xhr.onerror;
    xhr.ontimeout = xhr.onerror;
    xhr.send(body);
  });

  function getResponse(xhr, extra) {
    const { responseType } = options;
    let data;
    if (binaryTypes.includes(responseType)) {
      data = xhr.response;
    } else {
      data = xhr.responseText;
    }
    if (responseType === 'json') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        // Ignore invalid JSON
      }
    }
    return Object.assign({
      url,
      data,
      xhr,
    }, extra);
  }
}

const SIMPLE_VALUE_TYPE = {
  string: 's',
  number: 'n',
  boolean: 'b',
};

export function dumpScriptValue(value, jsonDump = JSON.stringify) {
  if (value !== undefined) {
    const simple = SIMPLE_VALUE_TYPE[typeof value];
    return `${simple || 'o'}${simple ? value : jsonDump(value)}`;
  }
}

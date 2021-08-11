// caching native properties to avoid being overridden, see violentmonkey/violentmonkey#151
import { numberToString } from '#/common';
import { assign, objectKeys } from '#/common/object';

export const { Promise } = global;

export const { filter, forEach, includes, join, map, push } = Array.prototype;
export const { charCodeAt, slice, replace } = String.prototype;
export const { toString: objectToString } = Object.prototype;
export const { addEventListener, removeEventListener } = EventTarget.prototype;
export const { append, appendChild, remove, setAttribute } = Element.prototype;
export const { createElementNS, getElementsByTagName } = document;
export const logging = assign({}, console);

export const NS_HTML = 'http://www.w3.org/1999/xhtml';

/** When looking for documentElement, use '*' to also support XML pages */
export const elemByTag = (tag, i) => document::getElementsByTagName(tag)[i || 0];

export const findElementIndex = (elem) => {
  for (
    let el, i = 0, elems = document::getElementsByTagName('*');
    (el = elems[i]);
    i += 1
  ) {
    if (el === elem) return i;
  }
};

// Firefox defines `isFinite` on `global` not on `window`
const { Boolean, Uint8Array, isFinite } = global; // eslint-disable-line no-restricted-properties
const { fromCharCode } = String;
const isArray = obj => (
  // ES3 way, not reliable if prototype is modified
  // Object.prototype.toString.call(obj) === '[object Array]'
  // #565 steamcommunity.com has overridden `Array.prototype`
  // support duck typing
  obj && typeof obj.length === 'number' && typeof obj.splice === 'function'
);

// Reference: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/JSON#Polyfill
const escMap = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};
const escRE = /[\\"\u0000-\u001F\u2028\u2029]/g; // eslint-disable-line no-control-regex
const escFunc = m => escMap[m] || `\\u${(m::charCodeAt(0) + 0x10000)::numberToString(16)::slice(1)}`;
export const jsonLoad = JSON.parse;
// When running in the page context we must beware of sites that override Array#toJSON
// leading to an invalid result, which is why our jsonDump() ignores toJSON.
// Thus, we use the native JSON.stringify() only in the content script context and only until
// a userscript is injected into this context (due to `@inject-into` and/or a CSP problem).
export function jsonDump(value) {
  if (value == null) return 'null';
  const type = typeof value;
  if (type === 'number') return isFinite(value) ? `${value}` : 'null';
  if (type === 'boolean') return `${value}`;
  if (type === 'object') {
    if (isArray(value)) {
      return `[${value::map(jsonDump)::join(',')}]`;
    }
    if (value::objectToString() === '[object Object]') {
      const res = objectKeys(value)::map((key) => {
        const v = value[key];
        return v !== undefined && `${jsonDump(key)}:${jsonDump(v)}`;
      });
      // JSON.stringify skips undefined in objects i.e. {foo: undefined} produces {}
      return `{${res::filter(Boolean)::join(',')}}`;
    }
  }
  return `"${value::replace(escRE, escFunc)}"`;
}

export function log(level, tags, ...args) {
  const tagList = ['Violentmonkey'];
  if (tags) tagList::push(...tags);
  const prefix = tagList::map(tag => `[${tag}]`)::join('');
  logging[level](prefix, ...args);
}

// uses ::safe calls unlike buffer2string in #/common
export function buffer2stringSafe(buf) {
  const size = buf.byteLength;
  // The max number of arguments varies between JS engines but it's >32k so 10k is safe
  const stepSize = 10e3;
  const stringChunks = [];
  for (let from = 0; from < size; from += stepSize) {
    const sourceChunk = new Uint8Array(buf, from, Math.min(stepSize, size - from));
    stringChunks::push(fromCharCode(...sourceChunk));
  }
  return stringChunks::join('');
}

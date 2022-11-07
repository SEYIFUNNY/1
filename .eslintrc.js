const { readGlobalsFile } = require('./scripts/webpack-util');

const FILES_INJECTED = [`src/injected/**/*.js`];
const FILES_CONTENT = [
  'src/injected/index.js',
  'src/injected/content/**/*.js',
];
const FILES_WEB = [`src/injected/web/**/*.js`];
/* Note that `injected` uses several more `common` files indirectly, but we check just these
 * two automatically because they are trivial by design and must always pass the check */
const FILES_SHARED = [
  'src/common/browser.js',
  'src/common/consts.js',
  'src/common/safe-globals-shared.js',
];

const GLOBALS_SHARED = getGlobals('*');
const GLOBALS_COMMON = {
  ...GLOBALS_SHARED,
  ...getGlobals('common'),
  re: false, // transform-modern-regexp with useRe option
};
const GLOBALS_INJECTED = {
  ...getGlobals('injected'),
  PAGE_MODE_HANDSHAKE: false,
  VAULT_ID: false,
};
const GLOBALS_CONTENT = {
  INIT_FUNC_NAME: false,
  ...GLOBALS_SHARED,
  ...getGlobals('injected/content'),
  ...GLOBALS_INJECTED,
};
const GLOBALS_WEB = {
  ...GLOBALS_SHARED,
  ...getGlobals('injected/web'),
  ...GLOBALS_INJECTED,
  IS_FIREFOX: false, // passed as a parameter to VMInitInjection in webpack.conf.js
};

const INJECTED_RULES = {
  'no-restricted-imports': ['error', {
    patterns: ['*/common', '*/common/*'],
  }],
  'no-restricted-syntax': [
    'error', {
      selector: 'ObjectExpression > ExperimentalSpreadProperty',
      message: 'Object spread adds a polyfill in injected* even if unused by it',
    }, {
      selector: 'ArrayPattern',
      message: 'Destructuring via Symbol.iterator may be spoofed/broken in an unsafe environment',
    }, {
      selector: ':matches(ArrayExpression, CallExpression) > SpreadElement',
      message: 'Spreading via Symbol.iterator may be spoofed/broken in an unsafe environment',
    }, {
      selector: '[callee.object.name="Object"], MemberExpression[object.name="Object"]',
      message: 'Using potentially spoofed methods in an unsafe environment',
      // TODO: auto-generate the rule using GLOBALS
    }, {
      selector: `CallExpression[callee.name="defineProperty"]:not(${[
        '[arguments.2.properties.0.key.name="__proto__"]',
        ':has(CallExpression[callee.name="nullObjFrom"])'
      ].join(',')})`,
      message: 'Prototype of descriptor may be spoofed/broken in an unsafe environment',
    }
  ],
};

module.exports = {
  root: true,
  extends: [
    require.resolve('@gera2ld/plaid/eslint'),
    require.resolve('@gera2ld/plaid-common-vue/eslint/vue3-js'),
  ],
  plugins: ['jest'],
  overrides: [{
    // `browser` is a local variable since we remove the global `chrome` and `browser` in injected*
    // to prevent exposing them to userscripts with `@inject-into content`
    files: ['*'],
    excludedFiles: [...FILES_INJECTED, ...FILES_SHARED],
    globals: {
      browser: false,
      ...GLOBALS_COMMON,
    },
  }, {
    files: FILES_SHARED,
    globals: GLOBALS_COMMON,
  }, {
    files: FILES_WEB,
    globals: GLOBALS_WEB,
  }, {
    files: FILES_CONTENT,
    globals: GLOBALS_CONTENT,
  }, {
    files: FILES_INJECTED,
    excludedFiles: [...FILES_CONTENT, ...FILES_WEB],
    // intersection of globals in CONTENT and WEB
    globals: Object.keys(GLOBALS_CONTENT).reduce((res, key) => (
      Object.assign(res, key in GLOBALS_WEB && { [key]: false })
    ), {}),
  }, {
    files: [...FILES_INJECTED, ...FILES_SHARED],
    rules: INJECTED_RULES,
  }, {
    files: FILES_WEB,
    rules: {
      ...INJECTED_RULES,
      'no-restricted-syntax': [
        ...INJECTED_RULES['no-restricted-syntax'],
        {
          selector: '[regex], NewExpression[callee.name="RegExp"]',
          message: 'RegExp internally depends on a *ton* of stuff that may be spoofed or broken',
          // https://262.ecma-international.org/12.0/#sec-regexpexec
        },
      ],
    },
  }, {
    // build scripts
    files: [
      '*.js',
      'scripts/*.js',
      'scripts/*.mjs',
    ],
    env: { node: true },
    rules: {
      'global-require': 0,
      'import/newline-after-import': 0,
      'import/no-extraneous-dependencies': 0, // spits errors in github action
      'import/extensions': 0,
    }
  }, {
    files: ['*.vue'],
    rules: {
      'vue/multi-word-component-names': 0,
    },
  }, {
    files: ['test/**'],
    env: {
      'jest/globals': true,
    },
  }],
  rules: {
    'prettier/prettier': 'off',
    // 'import/extensions': ['error', 'ignorePackages', {
    //   js: 'never',
    //   vue: 'never',
    // }],
    'no-use-before-define': ['error', {
      'functions': false,
      'classes': true,
      'variables': true,
      'allowNamedExports': true,
    }],
    // copied from airbnb-base, replaced 4 with 8
    'object-curly-newline': ['error', {
      ObjectExpression: { minProperties: 8, multiline: true, consistent: true },
      ObjectPattern: { minProperties: 8, multiline: true, consistent: true },
      ImportDeclaration: { minProperties: 8, multiline: true, consistent: true },
      ExportDeclaration: { minProperties: 8, multiline: true, consistent: true },
    }],
  },
};

function getGlobals(path) {
  const res = {};
  const { ast } = readGlobalsFile(path, { ast: true });
  ast.program.body.forEach(body => {
    const { declarations } = body.declaration || body;
    if (!declarations) return;
    declarations.forEach(function processId({
      id: {
        left,
        properties,
        name = left && left.name,
      },
    }) {
      if (name) {
        // const NAME = whatever
        // We consider `let` immutable too to avoid unintentional reassignment
        res[name] = false;
      } else if (properties) {
        // const { NAME1, prototype: { NAME2: ALIAS2 } } = whatever
        properties.forEach(({ value }) => processId({ id: value }));
      }
    });
  });
  return res;
}

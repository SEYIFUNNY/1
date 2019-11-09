const { modifyWebpackConfig, shallowMerge, defaultOptions } = require('@gera2ld/plaid');
const { isProd } = require('@gera2ld/plaid/util');
const webpack = require('webpack');
const WrapperWebpackPlugin = require('wrapper-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const projectConfig = require('./plaid.conf');
const mergedConfig = shallowMerge(defaultOptions, projectConfig);

const INIT_FUNC_NAME = 'VMInitInjection';

const definitions = new webpack.DefinePlugin({
  'process.env.INIT_FUNC_NAME': JSON.stringify(INIT_FUNC_NAME),
  'process.env.DEBUG': JSON.stringify(process.env.DEBUG || false),
});
const minimizerOptions = {
  cache: true,
  parallel: true,
  sourceMap: true,
  terserOptions: {
    output: {
      ascii_only: true,
    },
  },
};
const minimizer = isProd && [
  new TerserPlugin({
    chunkFilter: ({ name }) => !name.startsWith('public/'),
    ...minimizerOptions,
    terserOptions: {
      ...minimizerOptions.terserOptions,
      compress: {
        ecma: 6,
        // 'safe' since we don't rely on function prototypes
        unsafe_arrows: true,
      },
    },
  }),
  new TerserPlugin({
    chunkFilter: ({ name }) => name.startsWith('public/'),
    ...minimizerOptions,
  }),
];

const modify = (extra, init) => modifyWebpackConfig(
  (config) => {
    config.plugins.push(definitions);
    if (init) init(config);
    return config;
  }, {
    projectConfig: {
      ...mergedConfig,
      ...extra,
      optimization: {
        ...mergedConfig.optimization,
        ...(extra || {}).pages && {
          runtimeChunk: false,
          splitChunks: false,
        },
        minimizer,
      },
    },
  },
);

module.exports = Promise.all([
  modify(),
  modify({
    pages: {
      injected: {
        entry: './src/injected',
      },
    },
  }),
  modify({
    pages: {
      'injected-web': {
        entry: './src/injected/web',
      },
    },
  }, (config) => {
    config.output.libraryTarget = 'commonjs2';
    config.plugins.push(
      new WrapperWebpackPlugin({
        header: `\
          window.${INIT_FUNC_NAME} = function () {
            var module = { exports: {} };
          `,
        footer: `
            var exports = module.exports;
            return exports.__esModule ? exports['default'] : exports;
          };0;`,
      }),
    );
  }),
]);

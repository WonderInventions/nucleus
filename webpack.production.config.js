const webpack = require('webpack');

const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const config = require('./webpack.config');

// Hash all JS assets
config.output.filename = 'core.[contenthash].min.js';

// Remove devServer config
delete config.devServer;

// Remove HotModuleReplacement plugin
config.plugins = config.plugins.filter(p => !(p instanceof webpack.HotModuleReplacementPlugin));

// Remove source mapping
config.devtool = false;

// Set mode
config.mode = 'production';

// Add optimization
config.optimization = {
  minimize: true,
  minimizer: [
    new TerserPlugin({
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      },
    }),
  ],
};

// Add production plugins
config.plugins.unshift(
  new webpack.DefinePlugin({
    'process.env': {
      NODE_ENV: '"production"',
    },
  }),
  new MiniCssExtractPlugin({
    filename: '[contenthash].css',
  }));

module.exports = config;

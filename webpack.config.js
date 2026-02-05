const path = require('path');
const webpack = require('webpack');

const {BundleAnalyzerPlugin} = require('webpack-bundle-analyzer');
const FaviconsWebpackPlugin = require('favicons-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const loaders = require('./webpack.loaders');

const HOST = process.env.NUCLEUS_HOST || '127.0.0.1';
const PORT = process.env.NUCLEUS_PORT || '8888';

let mainPort = 3030;
try {
  mainPort = require('./config.js').port
} catch (err) {

}

module.exports = {
  entry: [
    './public/index.tsx',
  ],
  devtool: process.env.WEBPACK_DEVTOOL || 'eval-source-map',
  output: {
    publicPath: '/',
    path: path.join(__dirname, 'public_out'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: loaders,
  },
  devServer: {
    static: {
      directory: path.join(__dirname, 'public_out'),
    },
    hot: true,
    historyApiFallback: true,
    port: PORT,
    host: HOST,
    proxy: [
      {
        context: ['/rest'],
        target: `http://localhost:${mainPort}`
      }
    ]
  },
  plugins: [
    new webpack.HotModuleReplacementPlugin(),
    new HtmlWebpackPlugin({
      template: './public/template.html',
      title: 'Nucleus',
    }),
    new FaviconsWebpackPlugin({
      logo: path.resolve(__dirname, 'public/favicon.png'),
      mode: 'light',
    }),
  ],
};

if (process.env.ANALYZE) {
  module.exports.plugins.push(new BundleAnalyzerPlugin());
}

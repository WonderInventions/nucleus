module.exports = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|bower_components|public_out\/)/,
    use: [
      {
        loader: 'ts-loader',
        options: {
          configFile: 'tsconfig.public.json',
          transpileOnly: true
        }
      }
    ]
  },
  {
    test: /\.eot(\?v=\d+\.\d+\.\d+)?$/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset/resource',
  },
  {
    test: /\.(woff|woff2)$/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 5000
      }
    }
  },
  {
    test: /\.ttf(\?v=\d+\.\d+\.\d+)?$/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 10000
      }
    }
  },
  {
    test: /\.svg(\?v=\d+\.\d+\.\d+)?$/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 10000
      }
    }
  },
  {
    test: /\.gif/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 10000
      }
    }
  },
  {
    test: /\.jpg/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 10000
      }
    }
  },
  {
    test: /\.png/,
    exclude: /(node_modules|bower_components)/,
    type: 'asset',
    parser: {
      dataUrlCondition: {
        maxSize: 10000
      }
    }
  },
  {
    test: /\.css$/,
    exclude: /[/\\]src[/\\]/,
    use: [
      'style-loader',
      'css-loader',
    ],
  },
  {
    test: /\.scss$/,
    exclude: /[/\\](node_modules|bower_components|public_out\/)[/\\]/,
    use: [
      'style-loader',
      {
        loader: 'css-loader',
        options: {
          esModule: false,
          modules: {
            localIdentName: '[path]___[name]__[local]___[hash:base64:5]'
          },
          importLoaders: 2,
          sourceMap: true
        }
      },
      'postcss-loader',
      {
        loader: 'sass-loader',
        options: {
          api: 'modern',
        },
      },
    ],
  },
  {
    test: /\.css$/,
    exclude: /[/\\](node_modules|bower_components|public_out\/)[/\\]/,
    use: [
      'style-loader',
      {
        loader: 'css-loader',
        options: {
          esModule: false,
          modules: {
            localIdentName: '[path]___[name]__[local]___[hash:base64:5]'
          },
          importLoaders: 1,
          sourceMap: true
        }
      }
    ],
  },
];

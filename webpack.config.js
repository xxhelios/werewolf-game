const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');
const webpack = require('webpack');
const { version } = require('./package.json');

const defaultWebsocketUrl = 'wss://werewolf-game-rdj6.onrender.com';
const websocketUrl = process.env.WEBSOCKET_URL?.trim() || defaultWebsocketUrl;
if (websocketUrl) {
    let parsedWebsocketUrl;
    try {
        parsedWebsocketUrl = new URL(websocketUrl);
    } catch {
        throw new Error('WEBSOCKET_URL must be a valid ws:// or wss:// URL.');
    }
    if (!['ws:', 'wss:'].includes(parsedWebsocketUrl.protocol)) {
        throw new Error('WEBSOCKET_URL must use the ws:// or wss:// protocol.');
    }
}

module.exports = {
    entry: './src/main.ts',
    output: {
        filename: 'assets/[name].[contenthash].js',
        path: path.resolve(__dirname, 'dist'),
        clean: true,
        publicPath: './'
    },
    resolve: {
        extensions: ['.ts', '.js', '.vue']
    },
    module: {
        rules: [
            {
                test: /\.vue$/,
                loader: 'vue-loader'
            },
            {
                test: /\.tsx?$/,
                loader: 'ts-loader',
                options: {
                    appendTsSuffixTo: [/\.vue$/],
                    transpileOnly: true
                },
                exclude: /node_modules/
            },
            {
                test: /\.css$/i,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    plugins: [
        new VueLoaderPlugin(),
        new webpack.DefinePlugin({
            __WEBSOCKET_URL__: JSON.stringify(websocketUrl),
            __APP_VERSION__: JSON.stringify(version)
        }),
        new HtmlWebpackPlugin({
            template: './src/index.html'
        })
    ]
};

const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');

module.exports = {
    entry: './src/main.ts',
    output: {
        filename: 'assets/[name].[contenthash].js',
        path: path.resolve(__dirname, 'dist'),
        clean: true,
        publicPath: '/'
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
        new HtmlWebpackPlugin({
            template: './src/index.html'
        })
    ]
};

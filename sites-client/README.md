# おえかきあて — Sites frontend

Codex Sitesで公開するためのフロントエンドです。ゲーム本体のUIは
`../client/src`を再利用し、リアルタイム通信はRender上のSocket.IOサーバーへ接続します。

## Build

```bash
VITE_SOCKET_URL=https://testgame-pbmj.onrender.com npm run build
```

公開用ビルドは`dist/`に生成されます。
